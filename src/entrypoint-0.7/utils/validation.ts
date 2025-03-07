import {
    type Address,
    EntryPointAbi,
    RpcError,
    type UnPackedUserOperation,
    type PackedUserOperation
} from "@entrypoint-0.7/types"
import {
    type Chain,
    ContractFunctionExecutionError,
    ContractFunctionRevertedError,
    EstimateGasExecutionError,
    FeeCapTooLowError,
    InsufficientFundsError,
    IntrinsicGasTooLowError,
    NonceTooLowError,
    type PublicClient,
    TransactionExecutionError,
    type Transport,
    concat,
    encodeAbiParameters,
    getContract,
    getFunctionSelector,
    serializeTransaction,
    toBytes,
    toHex,
    bytesToHex
} from "viem"
import * as chains from "viem/chains"
import type { Logger } from "@alto/utils"
import { toPackedUserOperation } from "./userop"
import { getGasPrice } from "./gasPrice"

export interface GasOverheads {
    /**
     * fixed overhead for entire handleOp bundle.
     */
    fixed: number

    /**
     * per userOp overhead, added on top of the above fixed per-bundle.
     */
    perUserOp: number

    /**
     * overhead for userOp word (32 bytes) block
     */
    perUserOpWord: number

    // perCallDataWord: number

    /**
     * zero byte cost, for calldata gas cost calculations
     */
    zeroByte: number

    /**
     * non-zero byte cost, for calldata gas cost calculations
     */
    nonZeroByte: number

    /**
     * expected bundle size, to split per-bundle overhead between all ops.
     */
    bundleSize: number

    /**
     * expected length of the userOp signature.
     */
    sigSize: number
}

export const DefaultGasOverheads: GasOverheads = {
    fixed: 21000,
    perUserOp: 18300,
    perUserOpWord: 4,
    zeroByte: 4,
    nonZeroByte: 16,
    bundleSize: 1,
    sigSize: 65
}

/**
 * pack the userOperation
 * @param op
 *  "false" to pack entire UserOp, for calculating the calldata cost of putting it on-chain.
 */
export function packUserOp(op: UnPackedUserOperation): `0x${string}` {
    const packedUserOperation: PackedUserOperation = toPackedUserOperation(op)
    const randomDataUserOp: PackedUserOperation =
        packedUserOperationToRandomDataUserOp(packedUserOperation)

    return encodeAbiParameters(
        [
            {
                internalType: "address",
                name: "sender",
                type: "address"
            },
            {
                internalType: "uint256",
                name: "nonce",
                type: "uint256"
            },
            {
                internalType: "bytes",
                name: "initCode",
                type: "bytes"
            },
            {
                internalType: "bytes",
                name: "callData",
                type: "bytes"
            },
            {
                internalType: "uint256",
                name: "accountGasLimits",
                type: "bytes32"
            },
            {
                internalType: "uint256",
                name: "preVerificationGas",
                type: "uint256"
            },
            {
                internalType: "uint256",
                name: "gasFees",
                type: "bytes32"
            },
            {
                internalType: "bytes",
                name: "paymasterAndData",
                type: "bytes"
            },
            {
                internalType: "bytes",
                name: "signature",
                type: "bytes"
            }
        ],
        [
            randomDataUserOp.sender,
            randomDataUserOp.nonce, // need non zero bytes to get better estimations for preVerificationGas
            packedUserOperation.initCode,
            packedUserOperation.callData,
            randomDataUserOp.accountGasLimits, // need non zero bytes to get better estimations for preVerificationGas
            randomDataUserOp.preVerificationGas, // need non zero bytes to get better estimations for preVerificationGas
            randomDataUserOp.gasFees, // need non zero bytes to get better estimations for preVerificationGas
            randomDataUserOp.paymasterAndData,
            randomDataUserOp.signature
        ]
    )
}

export function packedUserOperationToRandomDataUserOp(
    packedUserOperation: PackedUserOperation
) {
    return {
        sender: packedUserOperation.sender,
        nonce: BigInt(
            "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
        ),
        initCode: packedUserOperation.initCode,
        callData: packedUserOperation.callData,
        accountGasLimits: bytesToHex(new Uint8Array(32).fill(255)),
        preVerificationGas: BigInt(
            "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
        ),
        gasFees: bytesToHex(new Uint8Array(32).fill(255)),
        paymasterAndData: bytesToHex(
            new Uint8Array(packedUserOperation.paymasterAndData.length).fill(
                255
            )
        ),
        signature: bytesToHex(
            new Uint8Array(packedUserOperation.signature.length).fill(255)
        )
    }
}

export async function calcPreVerificationGas(
    publicClient: PublicClient<Transport, Chain>,
    userOperation: UnPackedUserOperation,
    entryPoint: Address,
    chainId: number,
    logger: Logger,
    overheads?: GasOverheads
): Promise<bigint> {
    let preVerificationGas = calcDefaultPreVerificationGas(
        userOperation,
        overheads
    )

    if (chainId === 59140 || chainId === 59142) {
        preVerificationGas *= 2n
    } else if (
        chainId === chains.optimism.id ||
        chainId === chains.optimismSepolia.id ||
        chainId === chains.optimismGoerli.id ||
        chainId === chains.base.id ||
        chainId === chains.baseGoerli.id ||
        chainId === chains.baseSepolia.id ||
        chainId === chains.opBNB.id ||
        chainId === chains.opBNBTestnet.id ||
        chainId === 957 // Lyra chain
    ) {
        preVerificationGas = await calcOptimismPreVerificationGas(
            publicClient,
            userOperation,
            entryPoint,
            preVerificationGas,
            logger
        )
    } else if (chainId === chains.arbitrum.id) {
        preVerificationGas = await calcArbitrumPreVerificationGas(
            publicClient,
            userOperation,
            entryPoint,
            preVerificationGas
        )
    }

    return preVerificationGas
}

export async function calcVerificationGasAndCallGasLimit(
    publicClient: PublicClient<Transport, Chain>,
    userOperation: UnPackedUserOperation,
    executionResult: {
        preOpGas: bigint
        paid: bigint
    },
    chainId: number
) {
    const verificationGasLimit =
        ((executionResult.preOpGas - userOperation.preVerificationGas) * 3n) /
        2n

    let gasPrice: bigint

    if (userOperation.maxPriorityFeePerGas === userOperation.maxFeePerGas) {
        gasPrice = userOperation.maxFeePerGas
    } else {
        const blockBaseFee = (await publicClient.getBlock()).baseFeePerGas
        gasPrice =
            userOperation.maxFeePerGas <
            (blockBaseFee ?? 0n) + userOperation.maxPriorityFeePerGas
                ? userOperation.maxFeePerGas
                : userOperation.maxPriorityFeePerGas + (blockBaseFee ?? 0n)
    }
    const calculatedCallGasLimit =
        executionResult.paid / gasPrice -
        executionResult.preOpGas +
        21000n +
        50000n

    let callGasLimit =
        calculatedCallGasLimit > 9000n ? calculatedCallGasLimit : 9000n

    if (
        chainId === chains.baseGoerli.id ||
        chainId === chains.baseSepolia.id ||
        chainId === chains.base.id
    ) {
        callGasLimit = (110n * callGasLimit) / 100n
    }

    return [verificationGasLimit, callGasLimit]
}

/**
 * calculate the preVerificationGas of the given UserOperation
 * preVerificationGas (by definition) is the cost overhead that can't be calculated on-chain.
 * it is based on parameters that are defined by the Ethereum protocol for external transactions.
 * @param userOp filled userOp to calculate. The only possible missing fields can be the signature and preVerificationGas itself
 * @param overheads gas overheads to use, to override the default values
 */
export function calcDefaultPreVerificationGas(
    userOperation: UnPackedUserOperation,
    overheads?: Partial<GasOverheads>
): bigint {
    const ov = { ...DefaultGasOverheads, ...(overheads ?? {}) }

    const uop = {
        ...userOperation
    }

    uop.preVerificationGas ?? 21000n // dummy value, just for calldata cost
    uop.signature =
        uop.signature === "0x"
            ? toHex(Buffer.alloc(ov.sigSize, 1))
            : uop.signature // dummy signature

    const packedUserOperation = packUserOp(uop)

    const packed = toBytes(packedUserOperation)

    const lengthInWord = (packed.length + 31) / 32
    const callDataCost = packed
        .map((x) => (x === 0 ? ov.zeroByte : ov.nonZeroByte))
        .reduce((sum, x) => sum + x)
    const ret = Math.round(
        callDataCost +
            ov.fixed / ov.bundleSize +
            ov.perUserOp +
            ov.perUserOpWord * lengthInWord
    )

    return BigInt(ret)
}

const maxUint64 = 2n ** 64n - 1n

const getL1FeeAbi = [
    {
        inputs: [
            {
                internalType: "bytes",
                name: "data",
                type: "bytes"
            }
        ],
        name: "getL1Fee",
        outputs: [
            {
                internalType: "uint256",
                name: "fee",
                type: "uint256"
            }
        ],
        stateMutability: "nonpayable",
        type: "function"
    }
] as const

export async function calcOptimismPreVerificationGas(
    publicClient: PublicClient<Transport, Chain>,
    op: UnPackedUserOperation,
    entryPoint: Address,
    staticFee: bigint,
    logger: Logger
) {
    const packedUserOperation: PackedUserOperation = toPackedUserOperation(op)

    const randomDataUserOp: PackedUserOperation =
        packedUserOperationToRandomDataUserOp(packedUserOperation)

    const selector = getFunctionSelector(EntryPointAbi[28])
    const paramData = encodeAbiParameters(EntryPointAbi[28].inputs, [
        [randomDataUserOp],
        entryPoint
    ])
    const data = concat([selector, paramData])

    const latestBlock = await publicClient.getBlock()
    if (latestBlock.baseFeePerGas === null) {
        throw new RpcError("block does not have baseFeePerGas")
    }

    const serializedTx = serializeTransaction(
        {
            to: entryPoint,
            chainId: publicClient.chain.id,
            nonce: 999999,
            gasLimit: maxUint64,
            gasPrice: maxUint64,
            data
        },
        {
            r: "0x123451234512345123451234512345123451234512345123451234512345",
            s: "0x123451234512345123451234512345123451234512345123451234512345",
            v: 28n
        }
    )

    const opGasPriceOracle = getContract({
        abi: getL1FeeAbi,
        address: "0x420000000000000000000000000000000000000F",
        publicClient
    })

    const { result: l1Fee } = await opGasPriceOracle.simulate.getL1Fee([
        serializedTx
    ])

    const gasPrice = await getGasPrice(
        publicClient.chain,
        publicClient,
        true,
        logger
    )

    const l2MaxFee = gasPrice.maxFeePerGas
    const l2PriorityFee =
        latestBlock.baseFeePerGas + gasPrice.maxPriorityFeePerGas

    const l2price = l2MaxFee < l2PriorityFee ? l2MaxFee : l2PriorityFee

    return staticFee + l1Fee / l2price
}

const getArbitrumL1FeeAbi = [
    {
        inputs: [
            {
                internalType: "address",
                name: "to",
                type: "address"
            },
            {
                internalType: "bool",
                name: "contractCreation",
                type: "bool"
            },
            {
                internalType: "bytes",
                name: "data",
                type: "bytes"
            }
        ],
        name: "gasEstimateL1Component",
        outputs: [
            {
                internalType: "uint64",
                name: "gasEstimateForL1",
                type: "uint64"
            },
            {
                internalType: "uint256",
                name: "baseFee",
                type: "uint256"
            },
            {
                internalType: "uint256",
                name: "l1BaseFeeEstimate",
                type: "uint256"
            }
        ],
        stateMutability: "nonpayable",
        type: "function"
    }
] as const

export async function calcArbitrumPreVerificationGas(
    publicClient: PublicClient<Transport, Chain | undefined>,
    op: UnPackedUserOperation,
    entryPoint: Address,
    staticFee: bigint
) {
    const packedUserOperation: PackedUserOperation = toPackedUserOperation(op)

    const randomDataUserOp: PackedUserOperation =
        packedUserOperationToRandomDataUserOp(packedUserOperation)

    const selector = getFunctionSelector(EntryPointAbi[28])
    const paramData = encodeAbiParameters(EntryPointAbi[28].inputs, [
        [randomDataUserOp],
        entryPoint
    ])
    const data = concat([selector, paramData])

    const precompileAddress = "0x00000000000000000000000000000000000000C8"

    const serializedTx = serializeTransaction(
        {
            to: entryPoint,
            chainId: publicClient.chain?.id ?? 10,
            nonce: 999999,
            gasLimit: maxUint64,
            gasPrice: maxUint64,
            data
        },
        {
            r: "0x123451234512345123451234512345123451234512345123451234512345",
            s: "0x123451234512345123451234512345123451234512345123451234512345",
            v: 28n
        }
    )

    const arbGasPriceOracle = getContract({
        abi: getArbitrumL1FeeAbi,
        address: precompileAddress,
        publicClient
    })

    const { result } = await arbGasPriceOracle.simulate.gasEstimateL1Component([
        entryPoint,
        false,
        serializedTx
    ])

    return result[0] + staticFee
}

export function parseViemError(err: unknown) {
    if (
        err instanceof ContractFunctionExecutionError ||
        err instanceof TransactionExecutionError
    ) {
        const e = err.cause
        if (e instanceof NonceTooLowError) {
            return e
        }
        if (e instanceof FeeCapTooLowError) {
            return e
        }
        if (e instanceof InsufficientFundsError) {
            return e
        }
        if (e instanceof IntrinsicGasTooLowError) {
            return e
        }
        if (e instanceof ContractFunctionRevertedError) {
            return e
        }
        if (e instanceof EstimateGasExecutionError) {
            return e
        }
        return
    }
    return
}
