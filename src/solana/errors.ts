// Human-readable decoding of transaction errors returned by simulation / status.

/** spl-stake-pool `StakePoolError` (error.rs, declaration order). */
const STAKE_POOL_ERRORS = [
  'AlreadyInUse',
  'InvalidProgramAddress',
  'InvalidState',
  'CalculationFailure',
  'FeeTooHigh',
  'WrongAccountMint',
  'WrongManager',
  'SignatureMissing',
  'InvalidValidatorStakeList',
  'InvalidFeeAccount',
  'WrongPoolMint',
  'WrongStakeStake',
  'UserStakeNotActive',
  'ValidatorAlreadyAdded',
  'ValidatorNotFound',
  'InvalidStakeAccountAddress',
  'StakeListOutOfDate',
  'StakeListAndPoolOutOfDate',
  'UnknownValidatorStakeAccount',
  'WrongMintingAuthority',
  'UnexpectedValidatorListAccountSize',
  'WrongStaker',
  'NonZeroPoolTokenSupply',
  'StakeLamportsNotEqualToMinimum',
  'IncorrectDepositVoteAddress',
  'IncorrectWithdrawVoteAddress',
  'InvalidMintFreezeAuthority',
  'FeeIncreaseTooHigh',
  'WithdrawalTooSmall',
  'DepositTooSmall',
  'InvalidStakeDepositAuthority',
  'InvalidSolDepositAuthority',
  'InvalidPreferredValidator',
  'TransientAccountInUse',
  'InvalidSolWithdrawAuthority',
  'SolWithdrawalTooLarge',
  'InvalidMetadataAccount',
  'UnsupportedMintExtension',
  'UnsupportedFeeAccountExtension',
  'ExceededSlippage',
  'IncorrectMintDecimals',
  'ReserveDepleted',
  'MissingRequiredSysvar',
  'EpochRewardDistributionInProgress',
  'TooManyValidatorsInPool',
] as const;

export const STAKE_POOL_ERROR_HINTS: Record<string, string> = {
  StakeListAndPoolOutOfDate: 'the pool has not been updated for the new epoch yet; retry in a few minutes',
  ExceededSlippage: 'the pool would mint/pay less than the guaranteed minimum; nothing was spent',
  SolWithdrawalTooLarge: "the pool's reserve does not hold enough SOL for an instant withdrawal right now",
  ReserveDepleted: "the pool's reserve is depleted; instant SOL withdrawal is unavailable right now",
  EpochRewardDistributionInProgress: 'epoch rewards are still being distributed; retry shortly',
  InvalidSolDepositAuthority: 'this pool only accepts deposits signed by its deposit authority',
  InvalidSolWithdrawAuthority: 'this pool only allows SOL withdrawals signed by its withdraw authority',
};

export function stakePoolErrorName(code: number): string | undefined {
  return STAKE_POOL_ERRORS[code];
}

export interface DescribedError {
  summary: string;
  instructionIndex?: number;
  customCode?: number;
  name?: string;
  hint?: string;
  /** True when the program rejected unknown instruction data (e.g. unsupported instruction variant). */
  invalidInstructionData: boolean;
}

/**
 * Turns a transaction error (as returned by RPC: e.g. {"InstructionError":[3,{"Custom":17}]})
 * into a readable description. `programIdForIndex` maps instruction index -> program id.
 */
export function describeTransactionError(err: unknown, programIdForIndex: (i: number) => string | undefined, stakePoolProgramIds: string[]): DescribedError {
  if (err && typeof err === 'object' && 'InstructionError' in err) {
    const [index, inner] = (err as { InstructionError: [number, unknown] }).InstructionError;
    const programId = programIdForIndex(index);
    if (inner && typeof inner === 'object' && 'Custom' in inner) {
      const code = Number((inner as { Custom: number }).Custom);
      const isStakePool = programId !== undefined && stakePoolProgramIds.includes(programId);
      const name = isStakePool ? stakePoolErrorName(code) : undefined;
      const hint = name ? STAKE_POOL_ERROR_HINTS[name] : undefined;
      return {
        summary: `instruction ${index} (${programId ?? '?'}) failed with custom error ${code}${name ? ` (${name})` : ''}`,
        instructionIndex: index,
        customCode: code,
        ...(name ? { name } : {}),
        ...(hint ? { hint } : {}),
        invalidInstructionData: false,
      };
    }
    const innerText = typeof inner === 'string' ? inner : JSON.stringify(inner);
    return {
      summary: `instruction ${index} (${programId ?? '?'}) failed: ${innerText}`,
      instructionIndex: index,
      invalidInstructionData: inner === 'InvalidInstructionData',
    };
  }
  return { summary: `transaction failed: ${typeof err === 'string' ? err : JSON.stringify(err)}`, invalidInstructionData: false };
}
