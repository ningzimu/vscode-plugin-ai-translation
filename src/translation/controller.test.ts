import { TranslationController } from './controller';
import { TranslationConfig } from '../types';

const createMock = jest.fn();

jest.mock('openai', () => {
    return jest.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create: createMock,
            },
        },
    }));
});

describe('TranslationController', () => {
    const config: TranslationConfig = {
        apiEndpoint: 'https://api.minimaxi.com/v1',
        apiKey: 'test-key',
        model: 'MiniMax-M2.7-highspeed',
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate to {targetLanguage}',
        autoTranslate: false,
    };

    const webview = {
        postMessage: jest.fn(),
    };

    beforeEach(() => {
        createMock.mockReset();
        webview.postMessage.mockReset();
    });

    test('should request split reasoning for OpenAI-compatible providers', async () => {
        createMock.mockResolvedValue((async function* () {
            yield {
                choices: [
                    {
                        delta: {
                            content: 'translated',
                        },
                    },
                ],
            };
        })());

        const controller = new TranslationController(config, webview as any, 10);
        const chunks = [];

        for await (const chunk of controller.translate('source', 'zh-CN')) {
            chunks.push(chunk);
        }

        expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
            model: 'MiniMax-M2.7-highspeed',
            stream: true,
            reasoning_split: true,
        }));
        expect(chunks).toEqual([
            { content: 'translated', done: false },
            { content: '', done: true },
        ]);
    });
});
