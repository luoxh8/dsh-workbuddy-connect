/**
 * Smoke test for the modules under `lib/`: read the vault, print a status line
 * per account, and exercise the read-only snapshot path. No writes.
 *
 * Run with the workspace node: `node test/snapshot.mjs`.
 */

import { loadAccounts, ensureFresh, masked } from '../lib/upstream.js';
import { snapshot, nextStepOf } from '../lib/growth.js';

const accounts = await loadAccounts();
if (accounts.length === 0) {
  console.error('vault is empty');
  process.exit(1);
}

for (const account of accounts) {
  const fresh = await ensureFresh(account);
  const state = await snapshot(fresh);
  console.log(
    [
      `${state.nickname} (${state.accountId}) token=${masked(fresh.accessToken)}`,
      `  checkin=${state.checkin.todayCheckedIn} credits=${state.checkin.credits} streak=${state.checkin.streakDays}`,
      `  level=${state.profile.level} ${state.profile.levelName} ${state.profile.completed}/${state.profile.total}`,
      `  energy=${state.energy.balance} buddy=${state.buddy.name || '-'} travel=${state.travel.state}`,
      `  tasks=${state.tasks.map((task) => `${task.code}:${task.acceptStatus}:${task.current}/${task.target}`).join(' ')}`,
      `  next=${nextStepOf(state)}`,
    ].join('\n'),
  );
}
