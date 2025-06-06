use anchor_lang::prelude::*;
use modular_governance::{
  nft_proxy::accounts::ProxyAssignmentV0,
  proposal::accounts::{ProposalConfigV0, ProposalV0},
};
use shared_utils::resize_to_fit_pda;

use super::VoteArgsV0;
use crate::{error::VsrError, registrar_seeds, state::*};

#[derive(Accounts)]
pub struct ProxiedVoteV0<'info> {
  #[account(mut)]
  pub payer: Signer<'info>,
  #[account(
    init_if_needed,
    payer = payer,
    space = 8 + 32 + std::mem::size_of::<VoteMarkerV0>() + 1 + 2 * proposal.choices.len(),
    seeds = [b"marker", position.mint.key().as_ref(), proposal.key().as_ref()],
    bump
  )]
  pub marker: Box<Account<'info, VoteMarkerV0>>,
  #[account(mut)]
  pub registrar: Box<Account<'info, Registrar>>,
  pub voter: Signer<'info>,
  #[account(
    mut,
    has_one = registrar
  )]
  pub position: Box<Account<'info, PositionV0>>,
  #[account(
    has_one = voter,
    constraint = proxy_assignment.proxy_config == registrar.proxy_config,
    constraint = proxy_assignment.expiration_time > Clock::get().unwrap().unix_timestamp,
    // only the current or earlier proxies can change vote. Or if proposal not set, this was an `init` for the marker
    constraint = proxy_assignment.index <= marker.proxy_index || marker.proposal == Pubkey::default(),
    // Ensure this is actually for the position
    constraint = proxy_assignment.asset == position.mint,
  )]
  pub proxy_assignment: Box<Account<'info, ProxyAssignmentV0>>,
  #[account(
    mut,
    has_one = proposal_config,
    owner = proposal_program.key(),
  )]
  pub proposal: Account<'info, ProposalV0>,
  #[account(
    has_one = on_vote_hook,
    has_one = state_controller,
    owner = proposal_program.key()
  )]
  pub proposal_config: Account<'info, ProposalConfigV0>,
  /// CHECK: Checked via cpi
  #[account(mut)]
  pub state_controller: AccountInfo<'info>,
  /// CHECK: Checked via has_one
  pub on_vote_hook: AccountInfo<'info>,
  /// CHECK: Checked via constraint
  #[account(
    constraint = *proposal.to_account_info().owner == proposal_program.key()
  )]
  pub proposal_program: AccountInfo<'info>,
  pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ProxiedVoteV0>, args: VoteArgsV0) -> Result<()> {
  let marker = &mut ctx.accounts.marker;
  // Marker has not been allocated yet, need to handle rent payment
  if marker.rent_refund == Pubkey::default() {
    let rent = Rent::get()?;
    let reg_info = ctx.accounts.registrar.to_account_info();
    let min_rent = rent.minimum_balance(reg_info.data_len());
    let registrar_sol = reg_info.lamports();
    let marker_rent = rent.minimum_balance(marker.to_account_info().data_len());
    if registrar_sol > min_rent + marker_rent {
      **reg_info.lamports.borrow_mut() -= marker_rent;
      **ctx.accounts.payer.to_account_info().lamports.borrow_mut() += marker_rent;
      marker.rent_refund = ctx.accounts.registrar.key()
    } else {
      marker.rent_refund = ctx.accounts.payer.key();
    }
  }
  marker.proposal = ctx.accounts.proposal.key();
  marker.bump_seed = ctx.bumps.marker;
  marker.voter = ctx.accounts.voter.key();
  marker.mint = ctx.accounts.position.mint;
  marker.registrar = ctx.accounts.registrar.key();
  marker.proxy_index = ctx.accounts.proxy_assignment.index;

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

  ctx.accounts.position.num_active_votes += 1;

  let voting_mint_config =
    &ctx.accounts.registrar.voting_mints[usize::from(ctx.accounts.position.voting_mint_config_idx)];

  // Use the original voting weight for this nft until all votes removed
  // This prevents inconsistensies with decaying positions
  let weight = if marker.weight > 0 {
    marker.weight
  } else {
    ctx.accounts.position.voting_power(
      voting_mint_config,
      ctx.accounts.registrar.clock_unix_timestamp(),
    )?
  };
  marker.weight = weight;

  modular_governance::proposal::cpi::vote_v0(
    CpiContext::new_with_signer(
      ctx.accounts.proposal_program.to_account_info(),
      modular_governance::proposal::cpi::accounts::VoteV0 {
        voter: ctx.accounts.voter.to_account_info(),
        vote_controller: ctx.accounts.registrar.to_account_info(),
        state_controller: ctx.accounts.state_controller.to_account_info(),
        proposal_config: ctx.accounts.proposal_config.to_account_info(),
        proposal: ctx.accounts.proposal.to_account_info(),
        on_vote_hook: ctx.accounts.on_vote_hook.to_account_info(),
      },
      &[registrar_seeds!(ctx.accounts.registrar)],
    ),
    modular_governance::proposal::types::VoteArgsV0 {
      remove_vote: false,
      choice: args.choice,
      weight,
    },
  )?;

  ctx.accounts.position.add_recent_proposal(
    ctx.accounts.proposal.key(),
    ctx.accounts.proposal.created_at,
  );
  ctx.accounts.position.registrar_paid_rent = u64::try_from(
    i64::try_from(ctx.accounts.position.registrar_paid_rent).unwrap()
      + resize_to_fit_pda(
        &ctx.accounts.registrar.to_account_info(),
        &ctx.accounts.position,
      )?,
  )
  .unwrap();

  Ok(())
}
