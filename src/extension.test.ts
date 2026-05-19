import * as vscode from 'vscode';
import { activate } from './extension';
import { TranslationController } from './translation/controller';

jest.mock('./translation/controller');

const MockedTranslationController = TranslationController as jest.MockedClass<typeof TranslationController>;

type CommandMap = Record<string, (...args: any[]) => any>;

describe('extension preview behavior', () => {
    let commands: CommandMap;
    let webviewMessageHandler: ((message: any) => void | Promise<void>) | undefined;
    let postMessage: jest.Mock;
    let translateMock: jest.Mock;

    const markdownUri = {
        toString: () => 'file:///workspace/current.md',
    };

    const secondMarkdownUri = {
        toString: () => 'file:///workspace/second.md',
    };

    const markdownDocument = {
        languageId: 'markdown',
        uri: markdownUri,
        getText: jest.fn(() => '# Current'),
    };

    const secondMarkdownDocument = {
        languageId: 'markdown',
        uri: secondMarkdownUri,
        getText: jest.fn(() => '# Second'),
    };

    const context = {
        extensionUri: vscode.Uri,
        subscriptions: [],
        secrets: {
            get: jest.fn(async () => 'test-key'),
            store: jest.fn(),
            delete: jest.fn(),
        },
    } as any;

    beforeEach(() => {
        commands = {};
        webviewMessageHandler = undefined;
        postMessage = jest.fn();
        translateMock = jest.fn(async function* (source: string) {
            yield { content: `translated:${source}`, done: false };
            yield { content: '', done: true };
        });
        context.subscriptions = [];
        markdownDocument.getText.mockReturnValue('# Current');
        secondMarkdownDocument.getText.mockReturnValue('# Second');

        (vscode.workspace.openTextDocument as jest.Mock).mockImplementation(async (uri) => {
            if (uri.toString() === secondMarkdownUri.toString()) {
                return secondMarkdownDocument;
            }
            return markdownDocument;
        });
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((key, defaultValue) => ({
                apiEndpoint: 'https://api.openai.com/v1',
                model: 'gpt-4',
                targetLanguage: 'zh-CN',
                systemPrompt: 'Translate to {targetLanguage}',
                autoTranslate: true,
            } as Record<string, any>)[key] ?? defaultValue),
        });
        (vscode.window as any).activeTextEditor = {
            document: markdownDocument,
        };
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue({
            webview: {
                html: '',
                cspSource: 'vscode-webview:',
                asWebviewUri: jest.fn((uri) => uri),
                postMessage,
                onDidReceiveMessage: jest.fn((handler) => {
                    webviewMessageHandler = handler;
                    return { dispose: jest.fn() };
                }),
            },
            onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
            dispose: jest.fn(),
        });
        (vscode.commands.registerCommand as jest.Mock).mockImplementation((name, callback) => {
            commands[name] = callback;
            return { dispose: jest.fn() };
        });
        (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

        MockedTranslationController.mockClear();
        MockedTranslationController.mockImplementation(() => ({
            abort: jest.fn(),
            hasStartedStreaming: jest.fn(() => false),
            shouldCompleteInBackground: jest.fn(() => false),
            setWebview: jest.fn(),
            translate: translateMock,
        }) as any);
    });

    function openPreviewForResource(resource: any) {
        activate(context);
        return commands['aiTranslation.openPreview'](resource);
    }

    test('opening preview from a markdown resource binds that document instead of the active editor', async () => {
        (vscode.window as any).activeTextEditor = {
            document: markdownDocument,
        };

        await openPreviewForResource(secondMarkdownUri);
        await webviewMessageHandler?.({ type: 'ready' });

        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(secondMarkdownUri);
        expect(translateMock.mock.calls[0][0]).toBe('# Second');
    });
});
