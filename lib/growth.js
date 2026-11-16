/**
 * Growth-centre domain operations.
 *
 * Every path here is a real endpoint of the WorkBuddy growth service, taken from
 * the user-centre bundle (`GrowthI18nProvider`). Two families live here:
 *
 *   - **Reads** that answer on both gateways through `upstream.growth()`.
 *   - **Writes** so narrow that they need an explicit `apply` flag in the tool
 *     layer above: check-in, claim a finished task, draw the first buddy, and
 *     dispatch/collect the buddy's trip.
 *
 * Completion of a task is decided by the service, not by this module: there is
 * no "mark complete" endpoint. What this module can do is look at what a task
 * still needs and report it honestly.
 *
 * @module dsh-workbuddy-growth/growth
 */

import { growth, billing } from './upstream.js';

/** The five daily growth tasks, as the service names them. */
export const TASK_CODES = [
  'first_buddy',
  'RichMeow_Chat',
  'Library_read',
  'wb_wechat_oa_subscribe_task',
  'skill_share',
];

/** Every task the account has, with its status and progress. */
export async function tasks(credential) {
  const response = await growth(credential, 'GET', '/v2/activity/growth/tasks');
  const list = Array.isArray(response.data?.tasks) ? response.data.tasks : [];
  return list.map((task) => ({
    code: String(task.task_code ?? ''),
    title: String(task.title ?? ''),
    acceptStatus: String(task.accept_status ?? ''),
    current: Number(task.progress?.current ?? 0),
    target: Number(task.progress?.target ?? 0),
    reward: {
      credit: Number(task.reward_credit ?? 0),
      energy: Number(task.reward_energy ?? 0),
      buddy: task.reward_buddy === true,
    },
    jumpUrl: typeof task.jump_url === 'string' ? task.jump_url : '',
    validEnd: typeof task.valid_end === 'string' ? task.valid_end : '',
  }));
}

/** Growth profile: level, completed count, first-visit flag. */
export async function profile(credential) {
  const response = await growth(credential, 'GET', '/v2/activity/growth/profile');
  return response.data;
}

/** Check-in status for the account (read-only). */
export async function checkinStatus(credential) {
  const response = await billing(credential, '/v2/billing/meter/checkin-activity-status');
  return response;
}

/** Claim today's check-in reward. */
export async function checkin(credential) {
  return billing(credential, '/v2/billing/meter/daily-checkin');
}

/** Energy balance and buddy-draw affordability. */
export async function energy(credential) {
  const response = await growth(credential, 'GET', '/activity/growth/energy');
  return response.data;
}

/** The buddy the account currently owns, or null before the first one. */
export async function buddy(credential) {
  const response = await growth(credential, 'GET', '/activity/growth/buddy/info');
  return response.ok ? response.data?.buddy ?? response.data : response.data;
}

/** Trip state: idle, traveling, or arrived. */
export async function travelStatus(credential) {
  const response = await growth(credential, 'GET', '/activity/growth/buddy/travel/status');
  return response.data;
}

/** The four candidate destinations with their duration and reward bands. */
export async function travelConfig(credential) {
  const response = await growth(credential, 'GET', '/activity/growth/buddy/travel/config');
  const locations = Array.isArray(response.data?.locations) ? response.data.locations : [];
  return locations.map((location) => ({
    id: Number(location.id ?? 0),
    code: String(location.code ?? ''),
    name: String(location.name ?? ''),
    hoursMin: Number(location.duration_hours_min ?? 0),
    hoursMax: Number(location.duration_hours_max ?? 0),
    creditMin: Number(location.reward_credit_min ?? 0),
    creditMax: Number(location.reward_credit_max ?? 0),
  }));
}

/** Accept the buddy adoption agreement; idempotent on the service side. */
export async function agree(credential) {
  return growth(credential, 'POST', '/activity/growth/buddy/agreement', { agree: true });
}

/** Accept one or more tasks, which is a prerequisite for completing them. */
export async function acceptTasks(credential, codes) {
  const response = await growth(credential, 'POST', '/activity/growth/tasks/accept', { task_codes: codes });
  return response;
}

/** Claim a task whose progress reached its target. */
export async function claimTask(credential, code) {
  return growth(credential, 'POST', `/activity/growth/tasks/${code}/claim`);
}

/** Claim the beginner task, which mints the account's first buddy. */
export async function claimFirstBuddy(credential) {
  return growth(credential, 'POST', '/activity/growth/buddy/first');
}

/** Send the buddy to a destination for the day. */
export async function depart(credential, locationId) {
  return growth(credential, 'POST', '/activity/growth/buddy/travel/depart', { location_id: locationId });
}

/** Collect the trip reward once the buddy has arrived. */
export async function collect(credential) {
  return growth(credential, 'POST', '/activity/growth/buddy/travel/claim', {});
}

/**
 * The next action that would move this account forward, described rather than
 * performed. Used by the status tool so a report never invents a write.
 *
 * @param state - one entry from `snapshot()`.
 * @returns a sentence in the caller's language.
 */
export function nextStepOf(state) {
  const open = state.tasks.filter((task) => task.acceptStatus !== 'claimed');
  if (state.checkin?.todayCheckedIn !== true) return '今日还没签到';
  const claimable = open.filter((task) => task.acceptStatus === 'completed' || task.current >= task.target);
  if (claimable.length > 0) return `可领取：${claimable.map((task) => task.code).join('、')}`;
  const pending = open.filter((task) => task.target > 0 && task.current < task.target);
  if (pending.length > 0) {
    return `还差客户端动作：${pending.map((task) => `${task.code} ${task.current}/${task.target}`).join('、')}`;
  }
  if (state.travel?.state === 'idle' && state.travel?.dailyLimitReached !== true) return '猫还没派出去';
  if (state.travel?.state === 'arrived') return '旅行已到站，可收奖励';
  return '今天能做的都做完了';
}

/** One account's whole growth state, read-only. */
export async function snapshot(credential) {
  const [taskList, profileData, status, energyData, buddyData, trip] = await Promise.all([
    tasks(credential),
    profile(credential),
    checkinStatus(credential),
    energy(credential),
    buddy(credential),
    travelStatus(credential),
  ]);
  const data = status.data ?? {};
  return {
    accountId: credential.accountId,
    nickname: credential.nickname,
    checkin: {
      todayCheckedIn: data.today_checked_in === true,
      dailyCredit: Number(data.daily_credit ?? 0),
      todayCredit: Number(data.today_credit ?? 0),
      streakDays: Number(data.streak_days ?? 0),
      season: Number(data.season ?? 0),
      theme: typeof data.theme_name === 'string' ? data.theme_name : '',
      credits: Number(data.total_credits ?? 0),
      active: data.active === true,
    },
    profile: {
      completed: Number(profileData?.completed ?? 0),
      total: Number(profileData?.total ?? 0),
      level: Number(profileData?.level ?? 0),
      levelName: typeof profileData?.level_name === 'string' ? profileData.level_name : '',
      maxLevel: profileData?.max_level === true,
    },
    tasks: taskList,
    energy: {
      balance: Number(energyData?.balance ?? 0),
      affordable: Number(energyData?.affordable ?? 0),
      costPerOpen: Number(energyData?.cost_per_open ?? 0),
      maxOpen: Number(energyData?.max_open_count ?? 0),
    },
    buddy: {
      instanceId: Number(buddyData?.instance_id ?? 0),
      name: typeof buddyData?.name === 'string' ? buddyData.name : '',
      rarity: typeof buddyData?.rarity === 'string' ? buddyData.rarity : '',
      personality: typeof buddyData?.personality === 'string' ? buddyData.personality : '',
    },
    travel: {
      state: typeof trip?.state === 'string' ? trip.state : 'unknown',
      locationName: typeof trip?.location?.name === 'string' ? trip.location.name : '',
      rewardCredit: Number(trip?.reward_credit ?? 0),
      arriveAt: Number(trip?.arrive_at ?? 0),
      dailyLimitReached: trip?.daily_limit_reached === true,
    },
  };
}
