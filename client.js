window.__ModuleLoader__.load({
  id: 'dsh-codebuddy-llm',
  factory: (require) => {
    const React = require('react');
    const { IconChevronDownOutlineRegular, IconThinkOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
    const TOOL_EVENT = 'plugin:codebuddy/tool-call';
    const THOUGHT_EVENT = 'plugin:codebuddy/thought';
    const NS = 'codebuddy-tool';
    const en = {
      thought: 'Thought',
    };
    const zh = {
      thought: '思考',
    };
    const TOOL_NAMES = {
      Bash: 'bash', Read: 'read', Write: 'write', Edit: 'edit',
      Grep: 'grep', Glob: 'glob', WebSearch: 'web_search', WebFetch: 'web_fetch',
    };

    function inputObject(raw) {
      if (typeof raw !== 'string') return null;
      try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
      } catch {
        return null;
      }
    }

    function firstLine(value) {
      return typeof value === 'string' ? value.split('\n', 1)[0] : '';
    }

    function toolSummary(data) {
      const input = inputObject(data.input);
      const keys = data.toolName === 'Bash'
        ? ['command'] : ['file_path', 'path', 'query', 'pattern', 'url'];
      for (const key of keys) {
        const text = firstLine(input?.[key]);
        if (text) return text;
      }
      return firstLine(data.input) || data.callId;
    }

    function toolArgs(raw) {
      const value = inputObject(raw) ?? {};
      return {
        text: key => typeof value[key] === 'string' ? value[key] : undefined,
        complete: key => typeof value[key] === 'string',
        has: key => Object.hasOwn(value, key),
        value: key => value[key],
        closed: () => true,
        textPrefix: key => typeof value[key] === 'string' ? value[key] : undefined,
        stringExceeds: (key, length) => typeof value[key] === 'string' && value[key].length > length,
        stringLength: key => typeof value[key] === 'string' ? value[key].length : undefined,
        isSealed: () => true,
      };
    }

    function bashResultText(data) {
      const output = data.output ?? '';
      const match = /^Command: [^\n]*\nStdout: ([\s\S]*?)\n\nStderr: ([\s\S]*?)\nExit Code: (-?\d+|null)\nSignal: ([^\n]*)$/.exec(output);
      if (match === null) return output;
      const stdout = match[1] === '(empty)' ? '' : match[1];
      const stderr = match[2] === '(empty)' ? '' : match[2];
      const combined = [stdout, stderr].filter(Boolean).join('\n');
      const signal = match[4] !== '(none)' && match[4] !== ''
        ? `[killed by signal: ${match[4]}]` : `[exit code: ${match[3]}]`;
      return `${combined}\n${signal}`;
    }

    function toolBlock(data) {
      const input = inputObject(data.input) ?? {};
      const name = TOOL_NAMES[data.toolName] ?? data.toolName;
      const argsRaw = JSON.stringify({
        ...input,
        ...(name === 'bash' ? { description: input.description || input.command || 'Bash' } : {}),
        ...(['read', 'write', 'edit'].includes(name) && typeof input.file_path !== 'string'
          && typeof input.path === 'string' ? { file_path: input.path } : {}),
      });
      const args = toolArgs(argsRaw);
      if (data.status === 'running') return {
        phase: 'start', callId: data.callId, name, argsRaw, args,
        seq: data.anchorSeq, time: data.startedAt, subCalls: [],
      };
      return {
        kind: 'tool-result', callId: data.callId, name, args,
        call: { name, argsRaw }, content: [{ type: 'text', text: name === 'bash' ? bashResultText(data) : data.output ?? '' }],
        seq: data.anchorSeq, time: data.endedAt ?? data.startedAt,
        callTime: data.startedAt, isError: data.status === 'failed', subCalls: [],
      };
    }

    function ThoughtRow({ node, t }) {
      const e = React.createElement;
      return e('details', { className: 'cb-thought', 'data-codebuddy-thought': '' },
        e('summary', { className: 'cb-thought-summary' },
          e(IconThinkOutlineRegular, { size: 14, 'aria-hidden': true }),
          e('span', null, t('thought')),
          e('span', { className: 'cb-thought-preview' }, firstLine(node.data.text)),
          e(IconChevronDownOutlineRegular, { size: 14, className: 'cb-tool-chevron', 'aria-hidden': true })),
        e('pre', { className: 'cb-thought-body' }, node.data.text));
    }

    function eventId(data) {
      return `codebuddy:${data.provider}:${data.callId}`;
    }

    function match(event) {
      return event.type === TOOL_EVENT && event.data?.provider === 'codebuddy-cli'
        && typeof event.data.callId === 'string' && event.data.callId !== ''
        ? { id: eventId(event.data), role: 'start' } : null;
    }

    function start(_reader, match) {
      return { ...match.event.data, anchorSeq: match.event.seq, startedAt: match.event.time };
    }

    function update(context, match) {
      const data = match.event.data;
      return {
        ...context.state, ...data,
        input: data.input ?? context.state.input,
        output: data.output ?? context.state.output,
      };
    }

    function locationOf(context) {
      return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' };
    }

    const chatDefinition = {
      kind: 'codebuddy-tool-call', target: 'chat', match, start, update,
      publication: () => 'immediate',
      buildViewNode: context => context.state === undefined ? null : {
        key: context.key, kind: 'tool-call',
        id: context.id, target: 'chat',
        anchorSeq: context.state.anchorSeq, location: locationOf(context),
        visibility: 'visible', data: { root: toolBlock(context.state) },
      },
    };

    const thoughtDefinition = {
      kind: 'codebuddy-thought', target: 'chat',
      match: { [THOUGHT_EVENT]: event => event.data?.provider === 'codebuddy-cli'
        && typeof event.data.text === 'string' && event.data.text.trim() !== ''
        ? { id: `codebuddy:thought:${event.seq}`, role: 'start' } : null },
      start: (_reader, match) => ({ ...match.event.data, anchorSeq: match.event.seq }),
      update: context => context.state,
      publication: () => 'immediate',
      buildViewNode: context => ({
        key: context.key, kind: 'codebuddy-thought', id: context.id, target: 'chat',
        anchorSeq: context.state.anchorSeq, location: locationOf(context),
        visibility: 'visible', data: context.state,
      }),
    };

    function stepKind(name) {
      const key = TOOL_NAMES[name] ?? name;
      if (key === 'bash') return 'run';
      if (key === 'read') return 'read';
      if (key === 'write') return 'write';
      if (key === 'edit') return 'edit';
      if (key === 'grep') return 'search';
      if (key === 'glob') return 'list';
      if (key === 'web_search') return 'webSearch';
      if (key === 'web_fetch') return 'webFetch';
      return 'tool';
    }

    function executionNode(context) {
      const state = context.state;
      if (state === undefined) return null;
      const location = locationOf(context);
      const kind = stepKind(state.toolName);
      const command = inputObject(state.input)?.command;
      const summary = toolSummary(state);
      const title = kind === 'run' && typeof command === 'string'
        ? { kind: 'command', command } : { kind: 'tool', name: state.toolName };
      const status = state.status === 'ok' ? 'succeeded'
        : state.status === 'failed' ? 'failed' : 'running';
      const turn = location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : 0;
      return {
        key: context.key, kind: 'execution-step', id: context.id, target: 'execution',
        anchorSeq: state.anchorSeq, turn,
        data: {
          key: context.key, kind, status, anchorSeq: state.anchorSeq, turn,
          step: location.kind === 'step' ? location.step.step : 0,
          startedAt: state.startedAt,
          ...(status === 'running' ? {} : { endedAt: state.endedAt }),
          title, summary,
          detail: {
            kind: 'tool', name: state.toolName, argumentsRaw: state.input ?? '',
            ...(state.output === undefined ? {} : { content: state.output }),
            ...(status === 'failed' ? { isError: true } : {}),
          },
        },
      };
    }

    const executionDefinition = {
      kind: 'codebuddy-execution-step', target: 'execution', match, start,
      update: (context, match) => ({
        ...update(context, match),
        ...(match.event.data.status === 'running' ? {} : { endedAt: match.event.time }),
      }),
      publication: () => 'immediate', buildViewNode: executionNode,
    };

    const THOUGHT_STYLE = `.cb-thought{min-width:0}.cb-thought-summary{list-style:none;display:flex;align-items:center;gap:8px;min-height:32px;cursor:pointer;font-size:12px;color:inherit}
.cb-thought-summary::-webkit-details-marker{display:none}.cb-thought-summary:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.cb-thought-preview{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.55;flex:1}.cb-thought[open] .cb-tool-chevron{transform:rotate(180deg)}
.cb-thought-body{margin:4px 0 10px 22px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:500px;overflow:auto}`;

    const inject = ['uiConversation', 'slots', 'locale'];
    function apply(ctx) {
      ctx.uiConversation.events.register({ ...chatDefinition, match: { [TOOL_EVENT]: match } });
      ctx.uiConversation.events.register(thoughtDefinition);
      ctx.uiConversation.events.register({ ...executionDefinition, match: { [TOOL_EVENT]: match } });
      ctx.effect(() => ctx.locale.register(NS, {
        zh, en, ja: en, es: en, fr: en, de: en, ru: en, pt: en,
      }), 'codebuddy: tool copy');
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node', key: 'codebuddy-thought', locale: NS,
      }, ThoughtRow));
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.pluginCss = 'dsh-codebuddy-llm/tool';
        style.textContent = THOUGHT_STYLE;
        document.head.append(style);
        return () => style.remove();
      }, 'codebuddy: tool styles');
    }

    return { inject, apply };
  },
});
