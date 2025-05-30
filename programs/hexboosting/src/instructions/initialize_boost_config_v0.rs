use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use helium_sub_daos::{DaoV0, SubDaoV0};

use crate::BoostConfigV0;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct InitializeBoostConfigArgsV0 {
  /// The price in the oracle (usd) to burn boost
  pub boost_price: u64,
  /// The length of a period (defined as a month in the HIP)
  pub period_length: u32,
  /// The minimum of periods to boost
  pub minimum_periods: u16,
}

#[derive(Accounts)]
#[instruction(args: InitializeBoostConfigArgsV0)]
pub struct InitializeBoostConfigV0<'info> {
  #[account(mut)]
  pub payer: Signer<'info>,

  #[account(
    has_one = authority,
    has_one = dao
  )]
  pub sub_dao: Box<Account<'info, SubDaoV0>>,
  pub authority: Signer<'info>,
  /// CHECK: Just for settings
  pub rent_reclaim_authority: AccountInfo<'info>,
  /// CHECK: Just for settings
  pub start_authority: AccountInfo<'info>,
  /// CHECK: Pyth price oracle
  pub price_oracle: AccountInfo<'info>,
  pub dc_mint: Box<Account<'info, Mint>>,

  #[account(
    init,
    payer = payer,
    space = 8 + 60 + std::mem::size_of::<BoostConfigV0>(),
    seeds = ["boost_config".as_bytes(), dc_mint.key().as_ref()],
    bump,
  )]
  pub boost_config: Box<Account<'info, BoostConfigV0>>,
  pub system_program: Program<'info, System>,
  #[account(
    has_one = dc_mint
  )]
  pub dao: Box<Account<'info, DaoV0>>,
}

pub fn handler(
  ctx: Context<InitializeBoostConfigV0>,
  args: InitializeBoostConfigArgsV0,
) -> Result<()> {
  require_gt!(args.period_length, 0);

  ctx.accounts.boost_config.set_inner(BoostConfigV0 {
    sub_dao: ctx.accounts.sub_dao.key(),
    price_oracle: ctx.accounts.price_oracle.key(),
    payment_mint: ctx.accounts.dc_mint.key(),
    boost_price: args.boost_price,
    period_length: args.period_length,
    minimum_periods: args.minimum_periods,
    rent_reclaim_authority: ctx.accounts.rent_reclaim_authority.key(),
    bump_seed: ctx.bumps.boost_config,
    start_authority: ctx.accounts.start_authority.key(),
    dc_mint: ctx.accounts.dc_mint.key(),
  });

  Ok(())
}
