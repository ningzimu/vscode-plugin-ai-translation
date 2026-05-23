const vscodeUri = {
    scheme: 'file',
    path: '/extension',
    fsPath: '/extension',
    toString: jest.fn(() => 'file:///extension'),
    with: jest.fn(),
    joinPath: jest.fn((...parts) => ({
        scheme: 'file',
        path: parts.join('/'),
        fsPath: parts.join('/'),
        toString: jest.fn(() => parts.join('/')),
        with: jest.fn(),
    })),
};

module.exports = {
    Uri: vscodeUri,
    workspace: {
        openTextDocument: jest.fn(),
        getConfiguration: jest.fn(() => ({
            get: jest.fn((key, defaultValue) => {
                const defaults = {
                    apiEndpoint: 'https://api.openai.com/v1',
                    apiKey: '',
                    model: 'gpt-4',
                    targetLanguage: 'zh-CN',
                    systemPrompt: 'You are a professional translator. Translate the following markdown content to {targetLanguage}, preserving all markdown syntax, formatting, and structure.',
                    autoTranslate: false,
                };
                return defaults[key] || defaultValue;
            }),
        })),
    },
    window: {
        showInformationMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        withProgress: jest.fn(),
        createWebviewPanel: jest.fn(),
        activeTextEditor: undefined,
        visibleTextEditors: [],
        tabGroups: {
            activeTabGroup: {
                activeTab: undefined,
            },
        },
    },
    ViewColumn: {
        Two: 2,
    },
    commands: {
        executeCommand: jest.fn(),
        registerCommand: jest.fn(),
    },
    ProgressLocation: {
        Notification: 'notification',
    },
};
