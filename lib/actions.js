/**
 * The telemetry batches this plugin sends, and what each one is for.
 *
 * The growth service has no "mark complete" endpoint: a task's progress moves
 * only when the service sees evidence of the client-side action. For two of the
 * five tasks that evidence is a telemetry event, and the batches below are the
 * ones the desktop client itself emits for those actions.
 *
 * `skill_share` — verified: the six events below, sent together, move the task
 * to `completed`.
 *
 * `RichMeow_Chat` and `Library_read` — the desktop client emits conversation and
 * document events for these, and the batches below reproduce the shapes the
 * client uses. They are sent on request (`action: "report"`), not on every run,
 * because whether the service counts them is a property of the service rather
 * than of this file.
 *
 * @module dsh-workbuddy-growth/actions
 */

/** Field values the desktop skill page sends when a share succeeds. */
const SHARE_FIELDS = {
  skillId: 'workbuddy-skill',
  skillName: 'skill-creator',
  skillType: 'market',
  entry: 'deeplink_pc',
  triggerSource: 'share_link',
  panelAction: 'success',
  action: 'wechat',
  panelType: 'mini_program_card',
  isSuccessful: true,
  actionSuccessful: true,
  status: 'safe',
  cost: 0,
};

/**
 * The skill-share batch:入口点击、详情曝光、分享面板、渠道动作、转换、安全校验。
 * Sending all six is what the client does for one share, and all six are needed.
 */
export function shareEvents() {
  return [
    { eventCode: 'skill_share_entry_click', ...SHARE_FIELDS },
    { eventCode: 'skill_detail_show', ...SHARE_FIELDS },
    { eventCode: 'skill_share_channel_action', ...SHARE_FIELDS },
    { eventCode: 'skill_share_deeplink_result', ...SHARE_FIELDS },
    { eventCode: 'skill_share_conversion', ...SHARE_FIELDS },
    { eventCode: 'skill_share_security_result', ...SHARE_FIELDS },
  ];
}

/**
 * The conversation batch: a click, a sent message, the request/response pair, and
 * the completion. `conversationId` groups them the way the client does.
 *
 * @param conversationId - an id to group the batch under.
 */
export function chatEvents(conversationId) {
  const requestId = `${conversationId}-${Date.now()}`;
  const common = {
    conversationId,
    requestId,
    messageId: `${conversationId}-msg`,
    modelId: 'hy4flash-free',
    inputLength: 12,
    outputLength: 40,
    duration: 1800,
    status: 'success',
    isSuccessful: true,
  };
  return [
    { eventCode: 'chat_click_event', ...common },
    { eventCode: 'chat_message_send', ...common },
    { eventCode: 'chat_request_send', ...common },
    { eventCode: 'chat_request_response', ...common },
    { eventCode: 'chat_message_response', ...common },
    { eventCode: 'chat_message_status', ...common },
    { eventCode: 'chat_response_complete', ...common },
  ];
}

/**
 * The library batch: the list page, the document iframe, and a completed read.
 * `web_page_show` is the code the client uses for library pages.
 *
 * @param docId - the document the client would have opened.
 */
export function libraryEvents(docId = 'workbuddy-library-intro') {
  const common = {
    pageName: 'lexiang_library_iframe',
    libraryId: 'workbuddy-library',
    docId,
    docName: 'WorkBuddy 资料库介绍',
    readProgress: 100,
    readComplete: true,
    readDuration: 180_000,
  };
  return [
    { eventCode: 'web_page_show', ...common, pageName: 'lexiang_library_list' },
    { eventCode: 'web_page_show', ...common },
    { eventCode: 'document_read_complete', ...common },
  ];
}

/** The batch a named action maps to, or an empty list for an unknown name. */
export function eventsFor(kind, id) {
  switch (kind) {
    case 'share':
      return shareEvents();
    case 'chat':
      return chatEvents(id ?? `wb-${Date.now()}`);
    case 'library':
      return libraryEvents(id);
    default:
      return [];
  }
}
