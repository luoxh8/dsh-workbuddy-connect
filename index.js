/**
 * WorkBuddy growth-centre tools for DeepSeek Harness.
 *
 * The official `dsh-connect-workbuddy` bundle owns the model side of the account
 * pool: it routes chat completions to whichever pooled account has quota. It has
 * nothing to say about the growth centre — check-in streaks, the five daily
 * tasks, the buddy a beginner task mints, and that buddy's trip.
 *
 * This bundle owns exactly that: it reads the same vault
 * (`~/.dsh/workbuddy-vault/<region>/<accountId>.json`), keeps the access tokens
 * fresh, and exposes three tools.
 *
 *   status  — read-only picture of every pooled account.
 *   run     — the day's loop (check in, accept, claim, dispatch, collect). A
 *             write, so it needs `apply: true`.
 *   report  — send one telemetry batch for a named client action. Some tasks
 *             have no "mark complete" endpoint at all: progress moves only when
 *             the service sees the event the client would have emitted.
 *
 * No credential is ever logged or returned; `describe()` shows a masked token and
 * nothing more.
 *
 * @module dsh-workbuddy-connect
 */

import { defaultVaultDir, ensureFresh, loadAccounts, masked, report } from './lib/upstream.js';
import { runDay } from './lib/daily.js';
import * as growth from './lib/growth.js';
import { eventsFor } from './lib/actions.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'workbuddy-connect';

/** Services required before the tools can register. */
export const inject = ['tools'];

/** Default vault directory is `~/.dsh/workbuddy-vault/cn`. */
const DEFAULT_REGION = 'cn';

/** Region directory under the vault root. */
function vaultDirOf(config) {
  const region = typeof config?.region === 'string' && config.region !== '' ? config.region : DEFAULT_REGION;
  const override = typeof config?.vaultDir === 'string' && config.vaultDir !== '' ? config.vaultDir : '';
  return override !== '' ? override : defaultVaultDir().replace(/[\\/]cn$/, '') + `/${region}`;
}

/** Pick the accounts a call is about: all of them, or the ones named. */
function selectAccounts(accounts, wanted) {
  if (!Array.isArray(wanted) || wanted.length === 0) return accounts;
  const keys = wanted.map((entry) => String(entry).trim().toLowerCase()).filter((entry) => entry !== '');
  return accounts.filter((account) => {
    const haystack = [account.accountId, account.nickname, account.uid, account.uin].map((value) => value.toLowerCase());
    return keys.some((key) => haystack.some((value) => value === key || (value !== '' && value.includes(key))));
  });
}

/** Load every credential and make sure its token still works. */
async function readyAccounts(config) {
  const accounts = await loadAccounts(vaultDirOf(config));
  if (accounts.length === 0) throw new Error(`no account in the WorkBuddy vault at ${vaultDirOf(config)}`);
  const out = [];
  for (const account of accounts) {
    out.push(await ensureFresh(account));
  }
  return out;
}

/** One account line for the status tool, with the masked token as the only credential trace. */
function describe(account, state) {
  return {
    accountId: account.accountId,
    nickname: account.nickname,
    uid: account.uid,
    token: masked(account.accessToken),
    checkedIn: state.checkin.todayCheckedIn,
    credits: state.checkin.credits,
    streakDays: state.checkin.streakDays,
    level: state.profile.level,
    levelName: state.profile.levelName,
    completed: state.profile.completed,
    total: state.profile.total,
    energy: state.energy.balance,
    buddy: state.buddy.name === '' ? null : `${state.buddy.name}（${state.buddy.rarity}）`,
    travel: state.travel.state,
    travelTo: state.travel.locationName,
    tasks: state.tasks.map((task) => `${task.code}=${task.acceptStatus} ${task.current}/${task.target}`),
    next: growth.nextStepOf(state),
  };
}

/** The `parameters` JSON Schema for the shared account selector. */
const accountParameter = {
  type: 'array',
  items: { type: 'string' },
  description: '账号 id、昵称或 uid 的前缀；留空表示账号池里的全部账号。',
};

/** Register the three tools on the tools service. */
function registerTools(ctx, config) {
  ctx.tools.register({
    name: 'workbuddy_growth_status',
    description:
      '读取 WorkBuddy 账号池每个账号的成长中心状态：签到、五个每日任务进度、积分、能量、宠物与旅行。只读。',
    parameters: {
      type: 'object',
      properties: { accounts: accountParameter },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          accounts: { type: 'array', items: { type: 'string' } },
        },
        required: ['accounts'],
        additionalProperties: false,
      },
      render(args, value) {
        const lines = value.accounts;
        return [{ type: 'text', text: lines.length === 0 ? '账号池为空。' : lines.join('\n\n') }];
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      const selected = selectAccounts(await readyAccounts(config), args?.accounts);
      if (selected.length === 0) return { accounts: ['没有匹配的账号。'] };
      const lines = [];
      for (const account of selected) {
        const state = await growth.snapshot(account);
        const info = describe(account, state);
        lines.push(
          [
            `${info.nickname || info.accountId}（${info.accountId}）`,
            `  签到 ${info.checkedIn ? '已签' : '未签'} · 积分 ${info.credits} · 连续 ${info.streakDays} 天`,
            `  成长 Lv${info.level} ${info.levelName}（${info.completed}/${info.total}）· 能量 ${info.energy}`,
            `  宠物 ${info.buddy ?? '还没有'} · 旅行 ${info.travel}${info.travelTo === '' ? '' : `（${info.travelTo}）`}`,
            `  任务 ${info.tasks.join(' · ')}`,
            `  下一步 ${info.next}`,
          ].join('\n'),
        );
      }
      return { accounts: lines };
    },
  });

  ctx.tools.register({
    name: 'workbuddy_growth_run',
    description:
      '跑 WorkBuddy 账号池的每日积分流程：签到 → 接受任务 → 领新手任务开宠物 → 领取已完成任务 → 派宠物旅行（到站则收奖）。会写账号状态，必须显式传 apply:true。',
    parameters: {
      type: 'object',
      properties: {
        accounts: accountParameter,
        apply: {
          type: 'boolean',
          description: '必须为 true 才真正写入；false 时只回报将要做什么。',
        },
        report: {
          type: 'array',
          items: { type: 'string', enum: ['share', 'chat', 'library'] },
          description:
            '顺带发送哪几批客户端遥测事件。share（技能分享）经验证能推动 skill_share；chat 与 library 是尽力而为。',
        },
        locationId: {
          type: 'number',
          description: '指定旅行目的地 id（1 咖啡馆 / 2 商场店铺 / 3 健身房 / 4 古镇客栈）；留空选奖励最高的一处。',
        },
      },
      required: ['apply'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          applied: { type: 'boolean' },
          accounts: { type: 'array', items: { type: 'string' } },
        },
        required: ['applied', 'accounts'],
        additionalProperties: false,
      },
      render(args, value) {
        return [
          {
            type: 'text',
            text: value.accounts.length === 0 ? '账号池为空。' : `${value.applied ? '' : '（演练，未写入）\n'}${value.accounts.join('\n\n')}`,
          },
        ];
      },
    },
    timeoutMs: 300_000,
    async execute(args) {
      const selected = selectAccounts(await readyAccounts(config), args?.accounts);
      if (args?.apply !== true) {
        const lines = [];
        for (const account of selected) {
          const state = await growth.snapshot(account);
          lines.push(`${account.nickname || account.accountId}：${growth.nextStepOf(state)}`);
        }
        return { applied: false, accounts: lines };
      }
      const lines = [];
      for (const account of selected) {
        const result = await runDay(account, {
          reportKinds: Array.isArray(args?.report) ? args.report : [],
          locationId: typeof args?.locationId === 'number' ? args.locationId : undefined,
        });
        lines.push(
          [
            `${result.nickname || result.accountId}`,
            ...result.steps.map((step) => `  ${step}`),
            `  收尾：${result.tasks.join(' · ')}`,
            result.pending.length === 0 ? '  全部任务已完成' : `  仍待客户端动作：${result.pending.join(' · ')}`,
          ].join('\n'),
        );
      }
      return { applied: true, accounts: lines };
    },
  });

  ctx.tools.register({
    name: 'workbuddy_growth_report',
    description:
      '向 WorkBuddy 遥测入口补发一批客户端事件，用于推动没有「标记完成」接口的任务（技能分享、桌面端对话、资料库阅读）。推送后建议再跑一次 status 看进度是否真的动了。',
    parameters: {
      type: 'object',
      properties: {
        accounts: accountParameter,
        kind: {
          type: 'string',
          enum: ['share', 'chat', 'library'],
          description: 'share=技能分享六连事件；chat=一次对话的七连事件；library=资料库阅读事件。',
        },
        id: {
          type: 'string',
          description: 'chat 用它做 conversationId，library 用它做 docId；留空自动生成。',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { accounts: { type: 'array', items: { type: 'string' } } },
        required: ['accounts'],
        additionalProperties: false,
      },
      render(args, value) {
        return [{ type: 'text', text: value.accounts.join('\n') }];
      },
    },
    timeoutMs: 120_000,
    async execute(args) {
      const kind = String(args?.kind ?? '');
      const events = eventsFor(kind, typeof args?.id === 'string' && args.id !== '' ? args.id : undefined);
      if (events.length === 0) return { accounts: [`未知的事件类型：${kind}`] };
      const selected = selectAccounts(await readyAccounts(config), args?.accounts);
      const lines = [];
      for (const account of selected) {
        const sent = await report(account, events);
        const after = await growth.tasks(account);
        const moved = after
          .filter((task) => task.acceptStatus === 'completed' || task.acceptStatus === 'claimed')
          .map((task) => task.code);
        lines.push(
          `${account.nickname || account.accountId}：${sent.ok ? `已发 ${events.length} 条（${sent.base}）` : `发送失败 HTTP ${sent.status}`}；已完成 ${moved.join('、') || '无'}`,
        );
      }
      return { accounts: lines };
    },
  });
}

/**
 * Mount the tools.
 *
 * The registration goes through `ctx.inject(['tools'], …)` rather than a bare
 * `ctx.tools` read: Desktop's startup order decides when the tools service
 * appears, and an inject callback runs whenever it does.
 *
 * @param ctx - Cordis context.
 * @param config - `{ region?, vaultDir? }`.
 */
export function apply(ctx, config = {}) {
  ctx.inject(['tools'], (toolsCtx) => {
    if (toolsCtx.tools === undefined) return;
    registerTools(toolsCtx, config);
  });
}
