// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from '@jupyterlab/application';

import {
  ISessionContext,
  DOMUtils,
  IToolbarWidgetRegistry,
  ICommandPalette,
} from '@jupyterlab/apputils';

import { Cell, CodeCell } from '@jupyterlab/cells';

import { PageConfig, Text, Time, URLExt } from '@jupyterlab/coreutils';

import { IDocumentManager } from '@jupyterlab/docmanager';

import { IMainMenu } from '@jupyterlab/mainmenu';

import {
  NotebookPanel,
  INotebookTracker,
  INotebookTools,
} from '@jupyterlab/notebook';

import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { INotebookShell } from '@jupyter-notebook/application';

import { Poll } from '@lumino/polling';

import { Widget } from '@lumino/widgets';

import { TrustedComponent } from './trusted';

// External collaboration dependencies
import { Doc } from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { IndexeddbPersistence } from 'y-indexeddb';
import { YNotebook } from '@jupyter/ydoc';

// Internal collaboration components
import YjsNotebookProvider from '../../notebook/src/collab/provider';
import UserAwareness from '../../notebook/src/collab/awareness';
import CellLocking from '../../notebook/src/collab/locks';
import ChangeHistory from '../../notebook/src/collab/history';
import PermissionsSystem from '../../notebook/src/collab/permissions';
import CommentSystem from '../../notebook/src/collab/comments';

// UI components for collaboration
import CollaborationStatusBar from './components/collaborationBar';
import UserPresence from './components/userPresence';
import CellLockIndicator from './components/cellLockIndicator';
import HistoryViewer from './components/historyViewer';
import PermissionsDialog from './components/permissionsDialog';
import CommentSystemUI from './components/commentSystem';

/**
 * The class for kernel status errors.
 */
const KERNEL_STATUS_ERROR_CLASS = 'jp-NotebookKernelStatus-error';

/**
 * The class for kernel status warnings.
 */
const KERNEL_STATUS_WARN_CLASS = 'jp-NotebookKernelStatus-warn';

/**
 * The class for kernel status infos.
 */
const KERNEL_STATUS_INFO_CLASS = 'jp-NotebookKernelStatus-info';

/**
 * The class to fade out the kernel status.
 */
const KERNEL_STATUS_FADE_OUT_CLASS = 'jp-NotebookKernelStatus-fade';

/**
 * The class for scrolled outputs
 */
const SCROLLED_OUTPUTS_CLASS = 'jp-mod-outputsScrolled';

/**
 * The class for the full width notebook
 */
const FULL_WIDTH_NOTEBOOK_CLASS = 'jp-mod-fullwidth';

/**
 * The command IDs used by the notebook plugins.
 */
namespace CommandIDs {
  /**
   * A command to open right sidebar for Editing Notebook Metadata
   */
  export const openEditNotebookMetadata = 'notebook:edit-metadata';

  /**
   * A command to toggle full width of the notebook
   */
  export const toggleFullWidth = 'notebook:toggle-full-width';
}

/**
 * A plugin for the checkpoint indicator
 */
const checkpoints: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:checkpoints',
  description: 'A plugin for the checkpoint indicator.',
  autoStart: true,
  requires: [IDocumentManager, ITranslator],
  optional: [INotebookShell, IToolbarWidgetRegistry],
  activate: (
    app: JupyterFrontEnd,
    docManager: IDocumentManager,
    translator: ITranslator,
    notebookShell: INotebookShell | null,
    toolbarRegistry: IToolbarWidgetRegistry | null
  ) => {
    const { shell } = app;
    const trans = translator.load('notebook');
    const node = document.createElement('div');

    if (toolbarRegistry) {
      toolbarRegistry.addFactory('TopBar', 'checkpoint', (toolbar) => {
        const widget = new Widget({ node });
        widget.id = DOMUtils.createDomID();
        widget.addClass('jp-NotebookCheckpoint');
        return widget;
      });
    }

    const onChange = async () => {
      const current = shell.currentWidget;
      if (!current) {
        return;
      }
      const context = docManager.contextForWidget(current);

      context?.fileChanged.disconnect(onChange);
      context?.fileChanged.connect(onChange);

      const checkpoints = await context?.listCheckpoints();
      if (!checkpoints || !checkpoints.length) {
        return;
      }
      const checkpoint = checkpoints[checkpoints.length - 1];
      node.textContent = trans.__(
        'Last Checkpoint: %1',
        Time.formatHuman(new Date(checkpoint.last_modified))
      );
    };

    if (notebookShell) {
      notebookShell.currentChanged.connect(onChange);
    }

    new Poll({
      auto: true,
      factory: () => onChange(),
      frequency: {
        interval: 2000,
        backoff: false,
      },
      standby: 'when-hidden',
    });
  },
};

/**
 * Add a command to close the browser tab when clicking on "Close and Shut Down"
 */
const closeTab: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:close-tab',
  description:
    'Add a command to close the browser tab when clicking on "Close and Shut Down".',
  autoStart: true,
  requires: [IMainMenu],
  optional: [ITranslator],
  activate: (
    app: JupyterFrontEnd,
    menu: IMainMenu,
    translator: ITranslator | null
  ) => {
    const { commands } = app;
    translator = translator ?? nullTranslator;
    const trans = translator.load('notebook');

    const id = 'notebook:close-and-halt';
    commands.addCommand(id, {
      label: trans.__('Close and Shut Down Notebook'),
      execute: async () => {
        // Shut the kernel down, without confirmation
        await commands.execute('notebook:shutdown-kernel', { activate: false });
        window.close();
      },
    });
    menu.fileMenu.closeAndCleaners.add({
      id,
      // use a small rank to it takes precedence over the default
      // shut down action for the notebook
      rank: 0,
    });
  },
};

/**
 * Add a command to open the tree view from the notebook view
 */
const openTreeTab: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:open-tree-tab',
  description:
    'Add a command to open a browser tab on the tree view when clicking "Open...".',
  autoStart: true,
  optional: [ITranslator],
  activate: (app: JupyterFrontEnd, translator: ITranslator | null) => {
    const { commands } = app;
    translator = translator ?? nullTranslator;
    const trans = translator.load('notebook');

    const id = 'notebook:open-tree-tab';
    commands.addCommand(id, {
      label: trans.__('Open…'),
      execute: async () => {
        const url = URLExt.join(PageConfig.getBaseUrl(), 'tree');
        window.open(url);
      },
    });
  },
};

/**
 * A plugin to set the notebook to full width.
 */
const fullWidthNotebook: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:full-width-notebook',
  description: 'A plugin to set the notebook to full width.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ICommandPalette, ISettingRegistry, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    palette: ICommandPalette | null,
    settingRegistry: ISettingRegistry | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');

    let fullWidth = false;

    const toggleFullWidth = () => {
      const current = tracker.currentWidget;
      fullWidth = !fullWidth;
      if (!current) {
        return;
      }
      const content = current;
      content.toggleClass(FULL_WIDTH_NOTEBOOK_CLASS, fullWidth);
    };

    let notebookSettings: ISettingRegistry.ISettings;

    if (settingRegistry) {
      const loadSettings = settingRegistry.load(fullWidthNotebook.id);

      const updateSettings = (settings: ISettingRegistry.ISettings): void => {
        const newFullWidth = settings.get('fullWidthNotebook')
          .composite as boolean;
        if (newFullWidth !== fullWidth) {
          toggleFullWidth();
        }
      };

      Promise.all([loadSettings, app.restored])
        .then(([settings]) => {
          notebookSettings = settings;
          updateSettings(settings);
          settings.changed.connect((settings) => {
            updateSettings(settings);
          });
        })
        .catch((reason: Error) => {
          console.error(reason.message);
        });
    }

    app.commands.addCommand(CommandIDs.toggleFullWidth, {
      label: trans.__('Enable Full Width Notebook'),
      execute: () => {
        toggleFullWidth();
        if (notebookSettings) {
          notebookSettings.set('fullWidthNotebook', fullWidth);
        }
      },
      isEnabled: () => tracker.currentWidget !== null,
      isToggled: () => fullWidth,
    });

    if (palette) {
      palette.addItem({
        command: CommandIDs.toggleFullWidth,
        category: 'Notebook Operations',
      });
    }
  },
};

/**
 * The kernel logo plugin.
 */
const kernelLogo: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:kernel-logo',
  description: 'The kernel logo plugin.',
  autoStart: true,
  requires: [INotebookShell],
  optional: [IToolbarWidgetRegistry],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    toolbarRegistry: IToolbarWidgetRegistry | null
  ) => {
    const { serviceManager } = app;

    const node = document.createElement('div');
    const img = document.createElement('img');

    const onChange = async () => {
      const current = shell.currentWidget;
      if (!(current instanceof NotebookPanel)) {
        return;
      }

      if (!node.hasChildNodes()) {
        node.appendChild(img);
      }

      await current.sessionContext.ready;
      current.sessionContext.kernelChanged.disconnect(onChange);
      current.sessionContext.kernelChanged.connect(onChange);

      const name = current.sessionContext.session?.kernel?.name ?? '';
      const spec = serviceManager.kernelspecs?.specs?.kernelspecs[name];
      if (!spec) {
        node.childNodes[0].remove();
        return;
      }

      const kernelIconUrl = spec.resources['logo-64x64'];
      if (!kernelIconUrl) {
        node.childNodes[0].remove();
        return;
      }

      img.src = kernelIconUrl;
      img.title = spec.display_name;
    };

    if (toolbarRegistry) {
      toolbarRegistry.addFactory('TopBar', 'kernelLogo', (toolbar) => {
        const widget = new Widget({ node });
        widget.addClass('jp-NotebookKernelLogo');
        return widget;
      });
    }

    app.started.then(() => {
      shell.currentChanged.connect(onChange);
    });
  },
};

/**
 * A plugin to display the kernel status;
 */
const kernelStatus: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:kernel-status',
  description: 'A plugin to display the kernel status.',
  autoStart: true,
  requires: [INotebookShell, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    translator: ITranslator
  ) => {
    const trans = translator.load('notebook');
    const widget = new Widget();
    widget.addClass('jp-NotebookKernelStatus');
    app.shell.add(widget, 'menu', { rank: 10_010 });

    const removeClasses = () => {
      widget.removeClass(KERNEL_STATUS_ERROR_CLASS);
      widget.removeClass(KERNEL_STATUS_WARN_CLASS);
      widget.removeClass(KERNEL_STATUS_INFO_CLASS);
      widget.removeClass(KERNEL_STATUS_FADE_OUT_CLASS);
    };

    const onStatusChanged = (sessionContext: ISessionContext) => {
      const status = sessionContext.kernelDisplayStatus;
      let text = `Kernel ${Text.titleCase(status)}`;
      removeClasses();
      switch (status) {
        case 'busy':
        case 'idle':
          text = '';
          widget.addClass(KERNEL_STATUS_FADE_OUT_CLASS);
          break;
        case 'dead':
        case 'terminating':
          widget.addClass(KERNEL_STATUS_ERROR_CLASS);
          break;
        case 'unknown':
          widget.addClass(KERNEL_STATUS_WARN_CLASS);
          break;
        default:
          widget.addClass(KERNEL_STATUS_INFO_CLASS);
          widget.addClass(KERNEL_STATUS_FADE_OUT_CLASS);
          break;
      }
      widget.node.textContent = trans.__(text);
    };

    const onChange = async () => {
      const current = shell.currentWidget;
      if (!(current instanceof NotebookPanel)) {
        return;
      }
      const sessionContext = current.sessionContext;
      sessionContext.statusChanged.connect(onStatusChanged);
    };

    shell.currentChanged.connect(onChange);
  },
};

/**
 * A plugin to enable scrolling for outputs by default.
 * Mimic the logic from the classic notebook, as found here:
 * https://github.com/jupyter/notebook/blob/a9a31c096eeffe1bff4e9164c6a0442e0e13cdb3/notebook/static/notebook/js/outputarea.js#L96-L120
 */
const scrollOutput: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:scroll-output',
  description: 'A plugin to enable scrolling for outputs by default.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ISettingRegistry],
  activate: async (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    settingRegistry: ISettingRegistry | null
  ) => {
    const autoScrollThreshold = 100;
    let autoScrollOutputs = true;

    // decide whether to scroll the output of the cell based on some heuristics
    const autoScroll = (cell: CodeCell) => {
      if (!autoScrollOutputs) {
        // bail if disabled via the settings
        cell.removeClass(SCROLLED_OUTPUTS_CLASS);
        return;
      }
      const { outputArea } = cell;
      // respect cells with an explicit scrolled state
      const scrolled = cell.model.getMetadata('scrolled');
      if (scrolled !== undefined) {
        return;
      }
      const { node } = outputArea;
      const height = node.scrollHeight;
      const fontSize = parseFloat(node.style.fontSize.replace('px', ''));
      const lineHeight = (fontSize || 14) * 1.3;
      // do not set via cell.outputScrolled = true, as this would
      // otherwise synchronize the scrolled state to the notebook metadata
      const scroll = height > lineHeight * autoScrollThreshold;
      cell.toggleClass(SCROLLED_OUTPUTS_CLASS, scroll);
    };

    const handlers: { [id: string]: () => void } = {};

    const setAutoScroll = (cell: Cell) => {
      if (cell.model.type === 'code') {
        const codeCell = cell as CodeCell;
        const id = codeCell.model.id;
        autoScroll(codeCell);
        if (handlers[id]) {
          codeCell.outputArea.model.changed.disconnect(handlers[id]);
        }
        handlers[id] = () => autoScroll(codeCell);
        codeCell.outputArea.model.changed.connect(handlers[id]);
      }
    };

    tracker.widgetAdded.connect((sender, notebook) => {
      // when the notebook widget is created, process all the cells
      notebook.sessionContext.ready.then(() => {
        notebook.content.widgets.forEach(setAutoScroll);
      });

      notebook.model?.cells.changed.connect((sender, args) => {
        notebook.content.widgets.forEach(setAutoScroll);
      });
    });

    if (settingRegistry) {
      const loadSettings = settingRegistry.load(scrollOutput.id);
      const updateSettings = (settings: ISettingRegistry.ISettings): void => {
        autoScrollOutputs = settings.get('autoScrollOutputs')
          .composite as boolean;
      };

      Promise.all([loadSettings, app.restored])
        .then(([settings]) => {
          updateSettings(settings);
          settings.changed.connect((settings) => {
            updateSettings(settings);
          });
        })
        .catch((reason: Error) => {
          console.error(reason.message);
        });
    }
  },
};

/**
 * A plugin to add the NotebookTools to the side panel;
 */
const notebookToolsWidget: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:notebook-tools',
  description: 'A plugin to add the NotebookTools to the side panel.',
  autoStart: true,
  requires: [INotebookShell],
  optional: [INotebookTools],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    notebookTools: INotebookTools | null
  ) => {
    const onChange = async () => {
      const current = shell.currentWidget;
      if (!(current instanceof NotebookPanel)) {
        return;
      }

      // Add the notebook tools in right area.
      if (notebookTools) {
        shell.add(notebookTools, 'right', { type: 'Property Inspector' });
      }
    };
    shell.currentChanged.connect(onChange);
  },
};

/**
 * A plugin to update the tab icon based on the kernel status.
 */
const tabIcon: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:tab-icon',
  description: 'A plugin to update the tab icon based on the kernel status.',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    // the favicons are provided by Jupyter Server
    const baseURL = PageConfig.getBaseUrl();
    const notebookIcon = URLExt.join(
      baseURL,
      'static/favicons/favicon-notebook.ico'
    );
    const busyIcon = URLExt.join(baseURL, 'static/favicons/favicon-busy-1.ico');

    const updateBrowserFavicon = (
      status: ISessionContext.KernelDisplayStatus
    ) => {
      const link = document.querySelector(
        "link[rel*='icon']"
      ) as HTMLLinkElement;
      switch (status) {
        case 'busy':
          link.href = busyIcon;
          break;
        case 'idle':
          link.href = notebookIcon;
          break;
      }
    };

    const onChange = async () => {
      const current = tracker.currentWidget;
      const sessionContext = current?.sessionContext;
      if (!sessionContext) {
        return;
      }

      sessionContext.statusChanged.connect(() => {
        const status = sessionContext.kernelDisplayStatus;
        updateBrowserFavicon(status);
      });
    };

    tracker.currentChanged.connect(onChange);
  },
};

/**
 * A plugin that adds a Trusted indicator to the menu area
 */
const trusted: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:trusted',
  description: 'A plugin that adds a Trusted indicator to the menu area.',
  autoStart: true,
  requires: [INotebookShell, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    notebookShell: INotebookShell,
    translator: ITranslator
  ): void => {
    const onChange = async () => {
      const current = notebookShell.currentWidget;
      if (!(current instanceof NotebookPanel)) {
        return;
      }

      const notebook = current.content;
      await current.context.ready;

      const widget = TrustedComponent.create({ notebook, translator });
      notebookShell.add(widget, 'menu', {
        rank: 11_000,
      });
    };

    notebookShell.currentChanged.connect(onChange);
  },
};

/**
 * Add a command to open right sidebar for Editing Notebook Metadata when clicking on "Edit Notebook Metadata" under Edit menu
 */
const editNotebookMetadata: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:edit-notebook-metadata',
  description:
    'Add a command to open right sidebar for Editing Notebook Metadata when clicking on "Edit Notebook Metadata" under Edit menu',
  autoStart: true,
  optional: [ICommandPalette, ITranslator, INotebookTools],
  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette | null,
    translator: ITranslator | null,
    notebookTools: INotebookTools | null
  ) => {
    const { commands, shell } = app;
    translator = translator ?? nullTranslator;
    const trans = translator.load('notebook');

    commands.addCommand(CommandIDs.openEditNotebookMetadata, {
      label: trans.__('Edit Notebook Metadata'),
      execute: async () => {
        const command = 'application:toggle-panel';
        const args = {
          side: 'right',
          title: 'Show Notebook Tools',
          id: 'notebook-tools',
        };

        // Check if Show Notebook Tools (Right Sidebar) is open (expanded)
        if (!commands.isToggled(command, args)) {
          await commands.execute(command, args).then((_) => {
            // For expanding the 'Advanced Tools' section (default: collapsed)
            if (notebookTools) {
              const tools = (notebookTools?.layout as any).widgets;
              tools.forEach((tool: any) => {
                if (
                  tool.widget.title.label === trans.__('Advanced Tools') &&
                  tool.collapsed
                ) {
                  tool.toggle();
                }
              });
            }
          });
        }
      },
      isVisible: () =>
        shell.currentWidget !== null &&
        shell.currentWidget instanceof NotebookPanel,
    });

    if (palette) {
      palette.addItem({
        command: CommandIDs.openEditNotebookMetadata,
        category: 'Notebook Operations',
      });
    }
  },
};

/**
 * Plugin to initialize collaboration settings and configurations
 */
export const collaborationSettingsPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:collaboration-settings',
  description: 'Plugin to initialize collaboration settings and configurations',
  autoStart: true,
  requires: [ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ) => {
    const trans = translator.load('notebook');
    console.log(trans.__('Collaboration settings initialized'));
    
    // Initialize collaboration settings
    if (settings) {
      const loadSettings = settings.load(collaborationSettingsPlugin.id);
      loadSettings
        .then((settings) => {
          console.log('Collaboration settings loaded:', settings);
        })
        .catch((reason: Error) => {
          console.warn('Failed to load collaboration settings:', reason.message);
        });
    }
  }
};

/**
 * Plugin to provide Yjs document synchronization for collaborative editing
 */
export const yjsNotebookProviderPlugin: JupyterFrontEndPlugin<YjsNotebookProvider> = {
  id: '@jupyter-notebook/notebook-extension:yjs-notebook-provider',
  description: 'Plugin to provide Yjs document synchronization for collaborative editing',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ): YjsNotebookProvider => {
    const trans = translator.load('notebook');
    console.log(trans.__('YjsNotebookProvider initialized'));
    
    const provider = new YjsNotebookProvider({
      notebookPath: '',
      websocketUrl: 'ws://localhost:8888'
    });
    
    // Initialize connection management
    provider.connect();
    
    // Monitor connection state changes
    provider.onConnectionStateChanged.connect((sender, connectionState) => {
      console.log('Connection state changed:', connectionState);
    });
    
    // Handle notebook changes
    tracker.currentChanged.connect((sender, panel) => {
      if (panel) {
        console.log('Notebook changed, synchronizing with Yjs');
        // Synchronize with the new notebook
        provider.synchronizationStatus;
      }
    });
    
    return provider;
  }
};

/**
 * Plugin to track and display user presence in collaborative editing
 */
export const userAwarenessPlugin: JupyterFrontEndPlugin<UserAwareness> = {
  id: '@jupyter-notebook/notebook-extension:user-awareness',
  description: 'Plugin to track and display user presence in collaborative editing',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ): UserAwareness => {
    const trans = translator.load('notebook');
    console.log(trans.__('UserAwareness initialized'));
    
    const awareness = new UserAwareness({
      userId: 'default-user'
    });
    
    // Monitor user changes
    awareness.onUsersChanged.connect((sender, users) => {
      console.log('Users changed:', users);
    });
    
    // Track connection status
    awareness.onConnectionStatusChanged.connect((sender, status) => {
      console.log('Awareness connection status changed:', status);
    });
    
    // Update user count when notebooks change
    tracker.currentChanged.connect((sender, panel) => {
      if (panel) {
        console.log('Active users:', awareness.userCount);
      }
    });
    
    return awareness;
  }
};

/**
 * Plugin to manage cell locking for exclusive editing access
 */
export const cellLockingPlugin: JupyterFrontEndPlugin<CellLocking> = {
  id: '@jupyter-notebook/notebook-extension:cell-locking',
  description: 'Plugin to manage cell locking for exclusive editing access',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ): CellLocking => {
    const trans = translator.load('notebook');
    console.log(trans.__('CellLocking initialized'));
    
    const cellLocking = new CellLocking({
      provider: null,
      awareness: null
    });
    
    // Monitor lock state changes
    cellLocking.onLockStateChanged.connect((sender, lockState) => {
      console.log('Lock state changed:', lockState);
    });
    
    // Handle cell acquisition timeouts
    const timeout = cellLocking.lockAcquisitionTimeout;
    if (timeout > 0) {
      console.log('Lock acquisition timeout set to:', timeout);
    }
    
    // Add commands for lock management
    const { commands } = app;
    commands.addCommand('notebook:acquire-cell-lock', {
      label: trans.__('Acquire Cell Lock'),
      execute: async (args: any) => {
        const cellId = args.cellId;
        if (cellId) {
          await cellLocking.acquireLock(cellId);
        }
      }
    });
    
    commands.addCommand('notebook:release-cell-lock', {
      label: trans.__('Release Cell Lock'),
      execute: async (args: any) => {
        const cellId = args.cellId;
        if (cellId) {
          await cellLocking.releaseLock(cellId);
        }
      }
    });
    
    return cellLocking;
  }
};

/**
 * Plugin to track change history and provide version control
 */
export const changeHistoryPlugin: JupyterFrontEndPlugin<ChangeHistory> = {
  id: '@jupyter-notebook/notebook-extension:change-history',
  description: 'Plugin to track change history and provide version control',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ): ChangeHistory => {
    const trans = translator.load('notebook');
    console.log(trans.__('ChangeHistory initialized'));
    
    const history = new ChangeHistory({
      provider: null,
      awareness: null,
      notebookPath: ''
    });
    
    // Subscribe to changes
    history.subscribeToChanges(() => {
      console.log('Changes detected');
    });
    
    // Add commands for history management
    const { commands } = app;
    commands.addCommand('notebook:view-version-history', {
      label: trans.__('View Version History'),
      execute: async () => {
        const versionHistory = await history.getVersionHistory();
        console.log('Version history:', versionHistory);
      }
    });
    
    commands.addCommand('notebook:rollback-version', {
      label: trans.__('Rollback to Version'),
      execute: async (args: any) => {
        const version = args.version;
        if (version) {
          await history.rollbackToVersion(version);
        }
      }
    });
    
    return history;
  }
};

/**
 * Plugin to manage permissions for collaborative editing
 */
export const permissionsSystemPlugin: JupyterFrontEndPlugin<PermissionsSystem> = {
  id: '@jupyter-notebook/notebook-extension:permissions-system',
  description: 'Plugin to manage permissions for collaborative editing',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ): PermissionsSystem => {
    const trans = translator.load('notebook');
    console.log(trans.__('PermissionsSystem initialized'));
    
    const permissions = new PermissionsSystem({
      provider: null,
      awareness: null
    });
    
    // Monitor permission changes
    permissions.onPermissionChanged.connect((sender, permission) => {
      console.log('Permission changed:', permission);
    });
    
    // Add commands for permission management
    const { commands } = app;
    commands.addCommand('notebook:check-permissions', {
      label: trans.__('Check Permissions'),
      execute: async (args: any) => {
        const action = args.action;
        if (action) {
          const hasPermission = await permissions.checkPermission(action, 'user', 'notebook');
          console.log('Permission check result:', hasPermission);
        }
      }
    });
    
    commands.addCommand('notebook:manage-permissions', {
      label: trans.__('Manage Permissions'),
      execute: async () => {
        const userPermissions = await permissions.getUserPermissions('user');
        console.log('User permissions:', userPermissions);
      }
    });
    
    return permissions;
  }
};

/**
 * Plugin to provide comment system for collaborative discussions
 */
export const commentSystemPlugin: JupyterFrontEndPlugin<CommentSystem> = {
  id: '@jupyter-notebook/notebook-extension:comment-system',
  description: 'Plugin to provide comment system for collaborative discussions',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ): CommentSystem => {
    const trans = translator.load('notebook');
    console.log(trans.__('CommentSystem initialized'));
    
    const commentSystem = new CommentSystem({
      provider: null,
      awareness: null,
      notebookPath: ''
    });
    
    // Subscribe to comment changes
    commentSystem.subscribeToComments('', () => {
      console.log('Comments updated');
    });
    
    // Add commands for comment management
    const { commands } = app;
    commands.addCommand('notebook:create-comment', {
      label: trans.__('Create Comment'),
      execute: async (args: any) => {
        const { cellId, content } = args;
        if (cellId && content) {
          await commentSystem.createComment(cellId, content, 'user');
        }
      }
    });
    
    commands.addCommand('notebook:resolve-comment', {
      label: trans.__('Resolve Comment'),
      execute: async (args: any) => {
        const commentId = args.commentId;
        if (commentId) {
          await commentSystem.resolveComment(commentId);
        }
      }
    });
    
    return commentSystem;
  }
};

/**
 * Plugin to display collaboration status bar
 */
export const collaborationStatusBarPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:collaboration-status-bar',
  description: 'Plugin to display collaboration status bar',
  autoStart: true,
  requires: [INotebookShell, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ) => {
    const trans = translator.load('notebook');
    console.log(trans.__('CollaborationStatusBar initialized'));
    
    const statusBar = new CollaborationStatusBar({
      userAwareness: null,
      provider: null,
      connectionStatus: 'connected',
      users: [],
      sessionId: '',
      config: {}
    });
    
    // Add status bar to shell
    shell.add(statusBar, 'menu', { rank: 1000 });
    
    // Update connection status
    statusBar.updateConnectionStatus('connected');
    
    // Monitor notebook changes
    shell.currentChanged.connect((sender, panel) => {
      if (panel) {
        statusBar.updateUserCount(1);
      }
    });
  }
};

/**
 * Plugin to display user presence indicators
 */
export const userPresencePlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:user-presence',
  description: 'Plugin to display user presence indicators',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ) => {
    const trans = translator.load('notebook');
    console.log(trans.__('UserPresence initialized'));
    
    const presence = new UserPresence({
      users: [],
      visualSettings: {}
    });
    
    // Show presence indicators
    presence.showPresence();
    
    // Update user activity
    tracker.currentChanged.connect((sender, panel) => {
      if (panel) {
        presence.updateUserActivity(panel.id);
      }
    });
  }
};

/**
 * Plugin to display cell lock indicators
 */
export const cellLockIndicatorPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:cell-lock-indicator',
  description: 'Plugin to display cell lock indicators',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ) => {
    const trans = translator.load('notebook');
    console.log(trans.__('CellLockIndicator initialized'));
    
    const indicator = new CellLockIndicator({
      cellId: '',
      isLocked: false,
      lockOwner: '',
      lockTimestamp: 0,
      onLockStateChanged: () => {}
    });
    
    // Show lock status
    indicator.showLockStatus();
    
    // Update lock state
    tracker.currentChanged.connect((sender, panel) => {
      if (panel) {
        indicator.updateLockState(false, '', 0);
      }
    });
  }
};

/**
 * Plugin to provide history viewer interface
 */
export const historyViewerPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:history-viewer',
  description: 'Plugin to provide history viewer interface',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ) => {
    const trans = translator.load('notebook');
    console.log(trans.__('HistoryViewer initialized'));
    
    const viewer = new HistoryViewer({
      history: [],
      currentVersion: '',
      onVersionSelected: () => {}
    });
    
    // Add commands for history viewing
    const { commands } = app;
    commands.addCommand('notebook:show-history', {
      label: trans.__('Show History'),
      execute: async () => {
        viewer.showHistory();
      }
    });
    
    commands.addCommand('notebook:compare-versions', {
      label: trans.__('Compare Versions'),
      execute: async (args: any) => {
        const { version1, version2 } = args;
        if (version1 && version2) {
          viewer.compareVersions(version1, version2);
        }
      }
    });
    
    commands.addCommand('notebook:revert-to-version', {
      label: trans.__('Revert to Version'),
      execute: async (args: any) => {
        const version = args.version;
        if (version) {
          await viewer.revertToVersion(version);
        }
      }
    });
  }
};

/**
 * Plugin to provide permissions management dialog
 */
export const permissionsDialogPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:permissions-dialog',
  description: 'Plugin to provide permissions management dialog',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ) => {
    const trans = translator.load('notebook');
    console.log(trans.__('PermissionsDialog initialized'));
    
    const dialog = new PermissionsDialog({
      permissions: {},
      users: []
    });
    
    // Add commands for permissions management
    const { commands } = app;
    commands.addCommand('notebook:show-permissions-dialog', {
      label: trans.__('Manage Permissions'),
      execute: async () => {
        PermissionsDialog.showDialog({
          permissions: {},
          users: []
        });
      }
    });
    
    commands.addCommand('notebook:update-permissions', {
      label: trans.__('Update Permissions'),
      execute: async (args: any) => {
        const { userId, permissions } = args;
        if (userId && permissions) {
          // Update permissions via static method
          console.log('Updating permissions for:', userId);
        }
      }
    });
    
    commands.addCommand('notebook:invite-user', {
      label: trans.__('Invite User'),
      execute: async (args: any) => {
        const { email, permissions } = args;
        if (email && permissions) {
          // Invite user via static method
          console.log('Inviting user:', email);
        }
      }
    });
  }
};

/**
 * Plugin to provide comment system user interface
 */
export const commentSystemUIPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:comment-system-ui',
  description: 'Plugin to provide comment system user interface',
  autoStart: true,
  requires: [INotebookTracker, ITranslator],
  optional: [ISettingRegistry],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator,
    settings: ISettingRegistry | null
  ) => {
    const trans = translator.load('notebook');
    console.log(trans.__('CommentSystemUI initialized'));
    
    const commentUI = new CommentSystemUI({
      cellId: '',
      comments: []
    });
    
    // Add commands for comment UI
    const { commands } = app;
    commands.addCommand('notebook:show-comments', {
      label: trans.__('Show Comments'),
      execute: async (args: any) => {
        const cellId = args.cellId;
        if (cellId) {
          commentUI.render();
        }
      }
    });
    
    commands.addCommand('notebook:create-comment-ui', {
      label: trans.__('Create Comment'),
      execute: async (args: any) => {
        const { cellId, content } = args;
        if (cellId && content) {
          // Create comment via UI component
          console.log('Creating comment for cell:', cellId);
        }
      }
    });
    
    commands.addCommand('notebook:reply-to-comment', {
      label: trans.__('Reply to Comment'),
      execute: async (args: any) => {
        const { commentId, reply } = args;
        if (commentId && reply) {
          // Reply to comment via UI component
          console.log('Replying to comment:', commentId);
        }
      }
    });
    
    commands.addCommand('notebook:resolve-comment-ui', {
      label: trans.__('Resolve Comment'),
      execute: async (args: any) => {
        const commentId = args.commentId;
        if (commentId) {
          // Resolve comment via UI component
          console.log('Resolving comment:', commentId);
        }
      }
    });
  }
};

/**
 * Export the plugins as default.
 */
const plugins: JupyterFrontEndPlugin<any>[] = [
  checkpoints,
  closeTab,
  openTreeTab,
  editNotebookMetadata,
  fullWidthNotebook,
  kernelLogo,
  kernelStatus,
  notebookToolsWidget,
  scrollOutput,
  tabIcon,
  trusted,
  // Collaboration plugins - loaded after notebook-extension but before UI rendering
  collaborationSettingsPlugin,
  yjsNotebookProviderPlugin,
  userAwarenessPlugin,
  cellLockingPlugin,
  changeHistoryPlugin,
  permissionsSystemPlugin,
  commentSystemPlugin,
  collaborationStatusBarPlugin,
  userPresencePlugin,
  cellLockIndicatorPlugin,
  historyViewerPlugin,
  permissionsDialogPlugin,
  commentSystemUIPlugin,
];

export default plugins;
