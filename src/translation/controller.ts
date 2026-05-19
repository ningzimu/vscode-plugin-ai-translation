import OpenAI from 'openai';
import * as vscode from 'vscode';
import { TranslationConfig, TranslationChunk } from '../types';

type OpenAICompatibleChatRequest = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
    reasoning_split?: boolean;
};

export class TranslationController {
    private abortController: AbortController;
    private webview: vscode.Webview | null;
    private streamingStarted: boolean = false;
    private receivedBytes: number = 0;
    private totalBytes: number;
    private client: OpenAI;
    private config: TranslationConfig;

    constructor(config: TranslationConfig, webview: vscode.Webview, totalBytes: number) {
        this.config = config;
        this.client = new OpenAI({
            baseURL: config.apiEndpoint,
            apiKey: config.apiKey,
        });
        this.webview = webview;
        this.totalBytes = totalBytes;
        this.abortController = new AbortController();
    }

    /**
     * 检查是否应该继续后台完成（进度 >= 50%）
     */
    shouldCompleteInBackground(): boolean {
        const progress = (this.receivedBytes / this.totalBytes) * 100;
        return progress >= 50 && this.streamingStarted;
    }

    /**
     * 检查是否已开始流式传输
     */
    hasStartedStreaming(): boolean {
        return this.streamingStarted;
    }

    /**
     * 取消翻译
     */
    abort(): void {
        this.abortController.abort();
    }

    /**
     * 设置 webview（用于后台完成时置空）
     */
    setWebview(webview: vscode.Webview | null): void {
        this.webview = webview;
    }

    /**
     * 安全发送消息到 webview
     */
    private sendToWebview(message: any): void {
        if (this.webview) {
            try {
                this.webview.postMessage(message);
            } catch (error) {
                console.log('[TranslationController] Failed to send message to webview:', error);
            }
        }
    }

    /**
     * 执行翻译
     */
    async *translate(content: string, targetLanguage: string): AsyncGenerator<TranslationChunk> {
        // 发送状态：正在连接 API
        this.sendToWebview({ type: 'status', status: 'api_connecting' });

        const prompt = this.config.systemPrompt.replace('{targetLanguage}', targetLanguage);

        try {
            const request: OpenAICompatibleChatRequest = {
                model: this.config.model,
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: content },
                ],
                stream: true,
                reasoning_split: true,
            };

            const stream = await this.client.chat.completions.create(request);

            // 发送状态：开始翻译
            this.sendToWebview({ type: 'status', status: 'translating' });

            for await (const chunk of stream) {
                // 检查是否被中止
                if (this.abortController.signal.aborted) {
                    console.log('[TranslationController] Translation aborted');
                    return;
                }

                const delta = chunk.choices[0]?.delta?.content || '';
                if (delta) {
                    this.streamingStarted = true;
                    this.receivedBytes += delta.length;

                    const progress = Math.round((this.receivedBytes / this.totalBytes) * 100);

                    this.sendToWebview({
                        type: 'progress',
                        progress,
                        status: `翻译中... ${progress}%`
                    });

                    yield { content: delta, done: false };
                }
            }

            // 发送状态：完成并缓存
            this.sendToWebview({ type: 'status', status: 'completing' });
            yield { content: '', done: true };
        } catch (error) {
            if (this.abortController.signal.aborted) {
                // 正常中止，不抛出错误
                console.log('[TranslationController] Translation aborted by signal');
                return;
            }
            throw new Error(`翻译失败: ${(error as Error).message}`);
        }
    }
}
