use anchor_lang::prelude::*;
use modular_governance::proposal::accounts::ProposalV0;

use crate::{error::VsrError, state::*, VoteArgsV0};

#[derive(Accounts)]
pub struct ProxiedVoteV1<'info> {
  #[account(mut)]
  pub payer: Signer<'info>,
  #[account(
    init_if_needed,
    payer = payer,
    space = 8 + 32 + std::mem::size_of::<ProxyMarkerV0>() + 1 + 2 * proposal.choices.len(),
    seeds = ["proxy_marker".as_bytes(), voter.key().as_ref(), proposal.key().as_ref()],
    bump
  )]
  pub marker: Box<Account<'info, ProxyMarkerV0>>,
  pub voter: Signer<'info>,
  pub proposal: Account<'info, ProposalV0>,
  pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ProxiedVoteV1>, args: VoteArgsV0) -> Result<()> {
  let marker = &mut ctx.accounts.marker;
  marker.rent_refund = ctx.accounts.payer.key();
  marker.proposal = ctx.accounts.proposal.key();
  marker.bump_seed = ctx.bumps.marker;
  marker.voter = ctx.accounts.voter.key();

  // Don't allow voting for the same choice twice.
  require!(
    marker.choices.iter().all(|choice| *choice != args.choice),
    VsrError::NftAlreadyVoted
  );
  require_gt!(
    ctx.accounts.proposal.max_choices_per_voter,
    marker.choices.len() as u16,
    VsrError::MaxChoicesExceeded
  );

  marker.choices.push(args.choice);

  Ok(())
}
