import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConfigManager } from './config/manager';
import { TranslationCache } from './translation/cache';
import { generateHash } from './utils/hash';
import { TranslationController } from './translation/controller';

export function activate(context: vscode.ExtensionContext) {
    console.log('AI Translation Extension is now active!');

    const configManager = new ConfigManager(context);
    const translationCache = new TranslationCache();

    // 跟踪当前预览面板
    let previewPanel: vscode.WebviewPanel | undefined = undefined;

    // 跟踪当前翻译服务，避免重复翻译
    let currentTranslationService: TranslationController | null = null;

    /**
     * 创建或显示预览面板
     */
    async function showPreview(resourceUri?: vscode.Uri) {
        const document = resourceUri
            ? await vscode.workspace.openTextDocument(resourceUri)
            : vscode.window.activeTextEditor?.document;

        if (!document) {
            vscode.window.showWarningMessage('未找到活动的 Markdown 文件');
            return;
        }

        if (document.languageId !== 'markdown') {
            vscode.window.showWarningMessage('请打开一个 Markdown 文件');
            return;
        }

        // 如果面板已打开，先关闭
        if (previewPanel) {
            previewPanel.dispose();
        }

        // 创建新的预览面板
        const panel = vscode.window.createWebviewPanel(
            'aiTranslation.preview', // internal type
            'AI Translation Preview',
            vscode.ViewColumn.Two, // 在第二列显示
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
                ],
                retainContextWhenHidden: true,
            }
        );
        previewPanel = panel;

        // 加载 HTML
        panel.webview.html = getWebviewHtml(context.extensionUri, panel.webview);

        // 监听来自 webview 的消息
        panel.webview.onDidReceiveMessage(
            async (message) => {
                if (previewPanel !== panel) {
                    return;
                }
                console.log('[Extension] Received message from webview:', message);
                switch (message.type) {
                    case 'ready':
                        // Webview 已准备好，发送初始内容
                        await translateDocument(document);
                        break;
                    case 'retry':
                        await vscode.commands.executeCommand('aiTranslation.openPreview');
                        break;
                    case 'openSettings':
                        vscode.commands.executeCommand('workbench.action.openSettings', 'aiTranslation');
                        break;
                }
            }
        );

        // 监听面板关闭事件
        panel.onDidDispose(() => {
            if (previewPanel !== panel) {
                return;
            }
            console.log('[Extension] Webview disposed');

            if (currentTranslationService) {
                // 如果已经开始流式传输
                if (currentTranslationService.hasStartedStreaming()) {
                    if (currentTranslationService.shouldCompleteInBackground()) {
                        // 进度 >= 50%，静默完成并缓存
                        console.log('[Extension] Translation will complete in background');
                        currentTranslationService.setWebview(null);
                    } else {
                        // 进度 < 50%，立即中止
                        console.log('[Extension] Aborting translation (low progress)');
                        currentTranslationService.abort();
                    }
                } else {
                    // 还没开始传输（在配置验证、缓存检查等阶段），直接中止
                    console.log('[Extension] Aborting translation (not started)');
                    currentTranslationService.abort();
                }

                currentTranslationService = null;
            }

            previewPanel = undefined;
        });
    }

    /**
     * 翻译文档
     */
    async function translateDocument(document: vscode.TextDocument) {
        if (!previewPanel) {
            console.log('No preview panel available');
            return;
        }

        // 1. 验证配置
        previewPanel.webview.postMessage({ type: 'status', status: 'config_checking' });

        const config = await configManager.getFullConfig();
        const validation = configManager.validateConfig(config);
        if (!validation.valid) {
            // 如果是缺少 API key，提供设置选项
            if (validation.error?.includes('API key is required')) {
                const shouldSet = await vscode.window.showInformationMessage(
                    '请先设置您的 AI API 密钥',
                    '设置 API 密钥'
                );
                if (shouldSet) {
                    await configManager.promptForApiKey();
                }
            }
            previewPanel.webview.postMessage({
                type: 'error',
                error: `配置错误: ${validation.error}`
            });
            return;
        }

        // 2. 检查缓存
        previewPanel.webview.postMessage({ type: 'status', status: 'cache_checking' });

        const content = document.getText();
        const fileUri = document.uri.toString();
        const targetLanguage = config.targetLanguage;
        const fileHash = generateHash(content);
        // Use hash-based cache key to prevent cache key collision/poisoning
        const cacheKey = generateHash(`${fileUri}\0${targetLanguage}\0${fileHash}`);

        console.log('Translating document:', {
            uri: fileUri,
            length: content.length,
            targetLanguage,
        });

        // 检查缓存
        const cached = translationCache.get(cacheKey);
        if (cached) {
            console.log('Using cached translation');
            previewPanel.webview.postMessage({
                type: 'start'
            });
            previewPanel.webview.postMessage({
                type: 'chunk',
                content: cached.content
            });
            previewPanel.webview.postMessage({
                type: 'complete'
            });
            return;
        }

        // 3. 取消之前的翻译服务
        if (currentTranslationService) {
            console.log('Aborting previous translation');
            currentTranslationService.abort();
            currentTranslationService = null;
        }

        // 4. 创建新的翻译控制器
        currentTranslationService = new TranslationController(
            config,
            previewPanel.webview,
            content.length
        );

        let translatedContent = '';

        try {
            previewPanel.webview.postMessage({ type: 'start' });

            // 5. 开始流式翻译
            for await (const chunk of currentTranslationService.translate(content, targetLanguage)) {
                if (chunk.done) {
                    console.log('Translation complete');
                    previewPanel.webview.postMessage({ type: 'complete' });

                    // 缓存结果
                    translationCache.set(cacheKey, {
                        content: translatedContent,
                        timestamp: Date.now(),
                        sourceUri: fileUri,
                        targetLanguage,
                    });
                } else {
                    translatedContent += chunk.content;
                    previewPanel.webview.postMessage({
                        type: 'chunk',
                        content: chunk.content
                    });
                }
            }
        } catch (error) {
            console.error('Translation error:', error);
            if (previewPanel) {
                previewPanel.webview.postMessage({
                    type: 'error',
                    error: (error as Error).message
                });
            }
        }
    }

    // 注册打开预览命令
    const openPreviewCommand = vscode.commands.registerCommand(
        'aiTranslation.openPreview',
        async (resourceUri?: vscode.Uri) => {
            console.log('=== Opening preview ===');
            await showPreview(resourceUri);
        }
    );

    // 注册设置命令
    const openSettingsCommand = vscode.commands.registerCommand(
        'aiTranslation.openSettings',
        () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'aiTranslation');
        }
    );

    // 注册测试连接命令
    const testConnectionCommand = vscode.commands.registerCommand(
        'aiTranslation.testConnection',
        async () => {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: '正在测试 AI API 连接...',
                    cancellable: false,
                },
                async () => {
                    const result = await configManager.testConnection();
                    if (result.valid) {
                        vscode.window.showInformationMessage('✅ 连接成功!');
                    } else {
                        vscode.window.showErrorMessage(`❌ 连接失败: ${result.error}`);
                    }
                }
            );
        }
    );

    // 注册设置 API Key 命令
    const setApiKeyCommand = vscode.commands.registerCommand(
        'aiTranslation.setApiKey',
        async () => {
            await configManager.promptForApiKey();
        }
    );

    // 注册清除 API Key 命令
    const clearApiKeyCommand = vscode.commands.registerCommand(
        'aiTranslation.clearApiKey',
        async () => {
            await configManager.clearApiKey();
        }
    );

    context.subscriptions.push(
        openPreviewCommand,
        openSettingsCommand,
        testConnectionCommand,
        setApiKeyCommand,
        clearApiKeyCommand
    );

    console.log('AI Translation Extension activated successfully');
}

export function deactivate() {
    console.log('AI Translation Extension deactivated');
}

/**
 * Generate a cryptographic nonce for CSP
 */
function getNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

/**
 * 生成 Webview HTML
 */
function getWebviewHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
    const scriptPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'app.js');
    const scriptUri = webview.asWebviewUri(scriptPath);
    const cssPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'app-index.css');
    const cssUri = webview.asWebviewUri(cssPath);
    const baseUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview'));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
    <title>AI 翻译预览</title>
    <base href="${baseUri}/">
    <link rel="stylesheet" href="${cssUri}">
    <style nonce="${nonce}">
        body {
            margin: 0;
            padding: 0;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            height: 100vh;
            overflow: hidden;
        }
        #root {
            height: 100%;
            overflow-y: auto;
        }

        /* GitHub Flavored Markdown 样式 */
        /* 表格样式 */
        table {
            border-collapse: collapse;
            width: 100%;
            margin: 1em 0;
        }
        table th,
        table td {
            border: 1px solid var(--vscode-widget-border);
            padding: 6px 13px;
        }
        table th {
            background-color: var(--vscode-editor-selectionBackground);
            font-weight: 600;
        }
        table tr:nth-child(even) {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }

        /* 任务列表样式 */
        input[type="checkbox"] {
            margin-right: 8px;
        }

        /* 删除线样式 */
        del {
            text-decoration: line-through;
            opacity: 0.7;
        }

        /* 代码块样式 */
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 16px;
            overflow: auto;
            border-radius: 6px;
        }
        code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        pre code {
            padding: 0;
            background: none;
        }

        /* 引用块样式 */
        blockquote {
            border-left: 4px solid var(--vscode-textLink-foreground);
            padding-left: 16px;
            margin: 1em 0;
            opacity: 0.8;
        }

        /* 列表样式 */
        ul, ol {
            padding-left: 2em;
            margin: 1em 0;
        }
        li {
            margin: 0.5em 0;
        }

        /* 链接样式 */
        a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
