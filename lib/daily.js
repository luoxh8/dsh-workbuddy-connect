/**
 * The daily growth loop for one account, written as the sequence a person would
 * follow in the client: check in, accept what can be accepted, collect what is
 * already finished, send the buddy out, collect the trip when it has landed.
 *
 * Everything here is idempotent on the service side except the two "claim"
 * calls, which the service itself refuses to run twice — so a second run on the
 * same day is a no-op rather than an error.
 *
 * @module dsh-workbuddy-growth/daily
 */

import { report } from './upstream.js';
import * as growth from './growth.js';
import { eventsFor } from './actions.js';

/** Telemetry kinds a caller may ask for, in the order they are sent. */
const REPORT_KINDS = ['share', 'chat', 'library'];

/** The task each telemetry kind is meant to move. */
const KIND_TASK = {
  share: 'skill_share',
  chat: 'RichMeow_Chat',
  library: 'Library_read',
};

/** The destination with the best advertised reward among the configured ones. */
function bestLocation(locations) {
  let best = null;
  for (const location of locations) {
    if (best === null || location.creditMax > best.creditMax) best = location;
  }
  return best;
}

/** A short human line for one task entry. */
function taskLine(task) {
  return `${task.code}=${task.acceptStatus}${task.target > 0 ? ` ${task.current}/${task.target}` : ''}`;
}

/**
 * Run one account's day.
 *
 * @param credential - a loaded, already-refreshed credential.
 * @param options - `{ reportKinds, locationId }`.
 *   `reportKinds` lists which telemetry batches to send (`share` is the one the
 *   service is known to accept; `chat` and `library` are best-effort).
 *   `locationId` pins the trip destination instead of choosing the richest one.
 * @returns a per-account result with every step it took.
 */
export async function runDay(credential, options = {}) {
  const steps = [];
  const errors = [];
  const note = (text) => steps.push(text);
  const warn = (text) => {
    steps.push(`✗ ${text}`);
    errors.push(text);
  };

  // 1. Check in.
  const status = await growth.checkinStatus(credential);
  const alreadyCheckedIn = status.data?.today_checked_in === true;
  if (alreadyCheckedIn) {
    note('签到：今日已签');
  } else {
    const claim = await growth.checkin(credential);
    if (claim.ok) note('签到：已领取当日积分');
    else warn(`签到失败：${claim.message || 'unknown'}`);
  }

  // 2. Accept what the service will accept. `first_buddy` never needs it, and
  //    the dependent three refuse until a buddy instance exists.
  let current = await growth.tasks(credential);
  const toAccept = current
    .filter((task) => task.acceptStatus === 'not_accepted' && task.code !== 'first_buddy')
    .map((task) => task.code);
  if (toAccept.length > 0) {
    const accepted = await growth.acceptTasks(credential, toAccept);
    const results = Array.isArray(accepted.data?.results) ? accepted.data.results : [];
    const ok = results.filter((entry) => entry.status === 'accepted').map((entry) => entry.task_code);
    const refused = toAccept.filter((code) => !ok.includes(code));
    if (ok.length > 0) note(`接受任务：${ok.join('、')}`);
    if (refused.length > 0) note(`暂不可接受：${refused.join('、')}（依赖前置任务或宠物）`);
  }

  // 3. The beginner task: claim it to mint the account's first buddy.
  const firstBuddy = current.find((task) => task.code === 'first_buddy');
  if (firstBuddy !== undefined && firstBuddy.acceptStatus !== 'claimed') {
    const minted = await growth.claimFirstBuddy(credential);
    if (minted.ok) {
      const credit = Number(minted.data?.credit ?? 0);
      const energy = Number(minted.data?.energy ?? 0);
      note(`新手任务：已领取 +${credit} 积分 +${energy} 能量`);
    } else if (/not completed/i.test(minted.message)) {
      note('新手任务：还差一次客户端对话，先跳过');
    } else {
      warn(`新手任务失败：${minted.message || 'unknown'}`);
    }
  }

  // 4. Optional telemetry batches. Sent before the claim sweep so a batch that
  //    does land is collected in the same run.
  for (const kind of REPORT_KINDS) {
    if (!Array.isArray(options.reportKinds) || !options.reportKinds.includes(kind)) continue;
    const events = eventsFor(kind, kind === 'chat' ? `wb-${credential.accountId}-${Date.now()}` : undefined);
    if (events.length === 0) continue;
    const sent = await report(credential, events);
    const task = KIND_TASK[kind];
    note(sent.ok ? `上报 ${kind} 事件（${task}）` : `上报 ${kind} 事件未通：HTTP ${sent.status}`);
  }

  // 5. Claim everything the service now considers finished.
  current = await growth.tasks(credential);
  for (const task of current) {
    const finished = task.acceptStatus === 'completed' || (task.target > 0 && task.current >= task.target);
    if (!finished || task.acceptStatus === 'claimed') continue;
    const claimed = await growth.claimTask(credential, task.code);
    if (claimed.ok) {
      note(`领取 ${task.code}：+${task.reward.credit} 积分 +${task.reward.energy} 能量`);
    } else if (/already/i.test(claimed.message)) {
      note(`${task.code}：已领过`);
    } else {
      warn(`领取 ${task.code} 失败：${claimed.message || 'unknown'}`);
    }
  }

  // 6. The buddy's trip for the day.
  await growth.agree(credential);
  const trip = await growth.travelStatus(credential);
  const state = typeof trip?.state === 'string' ? trip.state : 'unknown';
  if (state === 'arrived') {
    const collected = await growth.collect(credential);
    if (collected.ok) {
      const credit = Number(collected.data?.reward_credit ?? collected.data?.credit ?? 0);
      note(`旅行已收：+${credit} 积分`);
    } else {
      warn(`旅行收取失败：${collected.message || 'unknown'}`);
    }
  } else if (state === 'traveling') {
    const arriveAt = Number(trip?.arrive_at ?? 0);
    note(`旅行中：${trip?.location?.name ?? '目的地'}，到站 ${arriveAt > 0 ? new Date(arriveAt * 1000).toLocaleString('zh-CN') : '未知'}`);
  } else if (trip?.daily_limit_reached === true) {
    note('旅行：今日次数已用完');
  } else {
    const locations = await growth.travelConfig(credential);
    const pinned =
      typeof options.locationId === 'number' ? locations.find((entry) => entry.id === options.locationId) : undefined;
    const target = pinned ?? bestLocation(locations);
    if (target === null) {
      warn('旅行：没有可用的目的地配置');
    } else {
      const departed = await growth.depart(credential, target.id);
      if (departed.ok) {
        const arriveAt = Number(departed.data?.arrive_at ?? 0);
        note(
          `派猫出门：${target.name}，预计 +${departed.data?.reward_credit ?? target.creditMax} 积分，到站 ${
            arriveAt > 0 ? new Date(arriveAt * 1000).toLocaleString('zh-CN') : '未知'
          }`,
        );
      } else {
        warn(`派猫失败：${departed.message || 'unknown'}`);
      }
    }
  }

  // 7. Final read, so the caller sees the state the run left behind.
  const finalTasks = await growth.tasks(credential);
  return {
    accountId: credential.accountId,
    nickname: credential.nickname,
    steps,
    errors,
    tasks: finalTasks.map(taskLine),
    pending: finalTasks.filter((task) => task.acceptStatus !== 'claimed').map((task) => `${task.code} ${task.current}/${task.target}`),
  };
}
