import { makeError } from '@core/Tool';
export const readPageTool = {
    name: 'readPage',
    description: 'Read the current page content as text, markdown, or simplified HTML.',
    inputSchema: {
        type: 'object',
        properties: {
            mode: {
                type: 'string',
                enum: ['text', 'markdown', 'html-simplified'],
                default: 'text',
            },
        },
    },
    async execute(input, ctx) {
        if (ctx.tabId === undefined) {
            return makeError('no_active_tab', 'no active tab to read from');
        }
        const mode = input.mode ?? 'text';
        return (await ctx.rpc.domOp({ kind: 'dom/readPage', tabId: ctx.tabId, mode }, 30_000));
    },
};
