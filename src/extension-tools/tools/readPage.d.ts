import type { ToolDefinition } from '@core';
import type { ExtensionToolCtx } from '../ctx';
interface ReadPageInput {
    mode?: 'text' | 'markdown' | 'html-simplified';
}
interface ReadPageOutput {
    text: string;
    url?: string;
    title?: string;
}
export declare const readPageTool: ToolDefinition<ReadPageInput, ReadPageOutput, ExtensionToolCtx>;
export {};
