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
  ReactWidget,
} from '@jupyterlab/apputils';

import { Token } from '@lumino/coreutils';

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

/**
 * Collaboration Service Tokens
 * These tokens define the interfaces for real-time collaboration features
 */

/**
 * The token for the collaboration provider service.
 * Provides YjsNotebookProvider for real-time document synchronization.
 */
export const ICollaborationProvider = new Token<ICollaborationProvider>(
  '@jupyter-notebook/notebook-extension:ICollaborationProvider',
  'A service that provides collaborative document editing capabilities using Yjs CRDT framework.'
);

/**
 * The token for the awareness service.
 * Manages user presence tracking and cursor position synchronization.
 */
export const IAwarenessService = new Token<IAwarenessService>(
  '@jupyter-notebook/notebook-extension:IAwarenessService',
  'A service that tracks user presence and cursor positions in collaborative sessions.'
);

/**
 * The token for the locking service.
 * Provides cell-level locking mechanism to prevent simultaneous edit conflicts.
 */
export const ILockService = new Token<ILockService>(
  '@jupyter-notebook/notebook-extension:ILockService',
  'A service that manages cell-level locks to prevent editing conflicts.'
);

/**
 * The token for the history service.
 * Manages document version history tracking and restoration capabilities.
 */
export const IHistoryService = new Token<IHistoryService>(
  '@jupyter-notebook/notebook-extension:IHistoryService',
  'A service that provides document version history and restoration capabilities.'
);

/**
 * The token for the permissions service.
 * Handles role-based access control (viewer, commenter, editor, owner).
 */
export const IPermissionsService = new Token<IPermissionsService>(
  '@jupyter-notebook/notebook-extension:IPermissionsService',
  'A service that manages role-based access control for collaborative sessions.'
);

/**
 * The token for the comment service.
 * Provides cell-level comment and discussion threading functionality.
 */
export const ICommentService = new Token<ICommentService>(
  '@jupyter-notebook/notebook-extension:ICommentService',
  'A service that manages cell-level comments and discussion threads.'
);

/**
 * Collaboration Service Interfaces
 */

export interface ICollaborationProvider {
  /**
   * Whether collaboration is currently active
   */
  readonly isCollaborating: boolean;

  /**
   * Enable collaboration for a notebook
   */
  enableCollaboration(notebook: NotebookPanel): Promise<void>;

  /**
   * Disable collaboration for a notebook
   */
  disableCollaboration(notebook: NotebookPanel): Promise<void>;

  /**
   * Get the collaboration provider for a notebook
   */
  getProvider(notebook: NotebookPanel): any; // YjsNotebookProvider type
}

export interface IAwarenessService {
  /**
   * Get active users in the current session
   */
  readonly activeUsers: any[]; // User type array

  /**
   * Track user awareness for a notebook
   */
  trackAwareness(notebook: NotebookPanel): void;

  /**
   * Stop tracking awareness for a notebook
   */
  stopTracking(notebook: NotebookPanel): void;
}

export interface ILockService {
  /**
   * Acquire a lock on a cell
   */
  acquireLock(cellId: string): Promise<boolean>;

  /**
   * Release a lock on a cell
   */
  releaseLock(cellId: string): Promise<void>;

  /**
   * Check if a cell is locked
   */
  isLocked(cellId: string): boolean;

  /**
   * Get the owner of a cell lock
   */
  getLockOwner(cellId: string): string | null;
}

export interface IHistoryService {
  /**
   * Get version history for a notebook
   */
  getHistory(notebook: NotebookPanel): any[]; // Version type array

  /**
   * Restore a specific version
   */
  restoreVersion(notebook: NotebookPanel, versionId: string): Promise<void>;

  /**
   * Create a snapshot of the current state
   */
  createSnapshot(notebook: NotebookPanel): Promise<string>;
}

export interface IPermissionsService {
  /**
   * Get user permissions for a notebook
   */
  getPermissions(notebook: NotebookPanel): any; // Permissions type

  /**
   * Set user permissions for a notebook
   */
  setPermissions(notebook: NotebookPanel, permissions: any): Promise<void>;

  /**
   * Check if user has specific permission
   */
  hasPermission(notebook: NotebookPanel, permission: string): boolean;
}

export interface ICommentService {
  /**
   * Get comments for a cell
   */
  getComments(cellId: string): any[]; // Comment type array

  /**
   * Add a comment to a cell
   */
  addComment(cellId: string, content: string): Promise<string>;

  /**
   * Resolve a comment thread
   */
  resolveComment(commentId: string): Promise<void>;
}

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
 * A plugin for the collaboration provider.
 * Provides YjsNotebookProvider for real-time document synchronization.
 */
const collaborationProvider: JupyterFrontEndPlugin<ICollaborationProvider> = {
  id: '@jupyter-notebook/notebook-extension:collaboration-provider',
  description: 'A plugin that provides collaborative document editing capabilities.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ITranslator],
  provides: ICollaborationProvider,
  activate: async (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator | null
  ): Promise<ICollaborationProvider> => {
    translator = translator ?? nullTranslator;

    // Implement lazy loading strategy for collaboration modules
    let YjsNotebookProvider: any = null;
    
    const loadCollaborationProvider = async () => {
      if (!YjsNotebookProvider) {
        try {
          // Dynamic import to reduce initial bundle size
          const module = await import('../../../notebook/src/collab/provider');
          YjsNotebookProvider = module.YjsNotebookProvider;
        } catch (error) {
          console.warn('Collaboration provider not available:', error);
          // Graceful fallback - return null to indicate collaboration is unavailable
          return null;
        }
      }
      return YjsNotebookProvider;
    };

    // Track active collaboration sessions
    const collaborationSessions = new Map<string, any>();

    const service: ICollaborationProvider = {
      get isCollaborating(): boolean {
        return collaborationSessions.size > 0;
      },

      async enableCollaboration(notebook: NotebookPanel): Promise<void> {
        const Provider = await loadCollaborationProvider();
        if (!Provider) {
          console.warn('Collaboration features not available - falling back to single-user mode');
          return;
        }

        try {
          const sessionId = notebook.id;
          if (!collaborationSessions.has(sessionId)) {
            const provider = new Provider(notebook);
            await provider.initialize();
            collaborationSessions.set(sessionId, provider);
            
            // Clean up on notebook disposal
            notebook.disposed.connect(() => {
              this.disableCollaboration(notebook);
            });
          }
        } catch (error) {
          console.error('Failed to enable collaboration:', error);
          // Graceful fallback - continue in single-user mode
        }
      },

      async disableCollaboration(notebook: NotebookPanel): Promise<void> {
        const sessionId = notebook.id;
        const provider = collaborationSessions.get(sessionId);
        if (provider) {
          try {
            await provider.dispose();
          } catch (error) {
            console.warn('Error disposing collaboration provider:', error);
          }
          collaborationSessions.delete(sessionId);
        }
      },

      getProvider(notebook: NotebookPanel): any {
        return collaborationSessions.get(notebook.id) || null;
      }
    };

    return service;
  }
};

/**
 * A plugin for the awareness service.
 * Manages user presence tracking and cursor position synchronization.
 */
const awarenessService: JupyterFrontEndPlugin<IAwarenessService> = {
  id: '@jupyter-notebook/notebook-extension:awareness-service',
  description: 'A plugin that provides user presence tracking for collaborative sessions.',
  autoStart: true,
  requires: [ICollaborationProvider],
  optional: [ITranslator],
  provides: IAwarenessService,
  activate: async (
    app: JupyterFrontEnd,
    collaborationProvider: ICollaborationProvider,
    translator: ITranslator | null
  ): Promise<IAwarenessService> => {
    translator = translator ?? nullTranslator;

    let AwarenessManager: any = null;

    const loadAwarenessManager = async () => {
      if (!AwarenessManager) {
        try {
          const module = await import('../../../notebook/src/collab/awareness');
          AwarenessManager = module.AwarenessManager;
        } catch (error) {
          console.warn('Awareness service not available:', error);
          return null;
        }
      }
      return AwarenessManager;
    };

    const trackedNotebooks = new Set<NotebookPanel>();
    let currentUsers: any[] = [];

    const service: IAwarenessService = {
      get activeUsers(): any[] {
        return [...currentUsers];
      },

      async trackAwareness(notebook: NotebookPanel): Promise<void> {
        const Manager = await loadAwarenessManager();
        if (!Manager || !collaborationProvider.isCollaborating) {
          return;
        }

        try {
          const provider = collaborationProvider.getProvider(notebook);
          if (provider && !trackedNotebooks.has(notebook)) {
            const awareness = new Manager(provider);
            awareness.initialize();
            trackedNotebooks.add(notebook);

            // Update active users when awareness changes
            awareness.usersChanged.connect(() => {
              currentUsers = awareness.getActiveUsers();
            });

            notebook.disposed.connect(() => {
              this.stopTracking(notebook);
            });
          }
        } catch (error) {
          console.warn('Failed to initialize awareness tracking:', error);
        }
      },

      stopTracking(notebook: NotebookPanel): void {
        trackedNotebooks.delete(notebook);
      }
    };

    return service;
  }
};

/**
 * A plugin for the locking service.
 * Provides cell-level locking mechanism to prevent simultaneous edit conflicts.
 */
const lockService: JupyterFrontEndPlugin<ILockService> = {
  id: '@jupyter-notebook/notebook-extension:lock-service',
  description: 'A plugin that provides cell-level locking for collaborative editing.',
  autoStart: true,
  requires: [ICollaborationProvider],
  optional: [ITranslator],
  provides: ILockService,
  activate: async (
    app: JupyterFrontEnd,
    collaborationProvider: ICollaborationProvider,
    translator: ITranslator | null
  ): Promise<ILockService> => {
    translator = translator ?? nullTranslator;

    let LockManager: any = null;

    const loadLockManager = async () => {
      if (!LockManager) {
        try {
          const module = await import('../../../notebook/src/collab/locks');
          LockManager = module.CellLockManager;
        } catch (error) {
          console.warn('Lock service not available:', error);
          return null;
        }
      }
      return LockManager;
    };

    let lockManager: any = null;

    const service: ILockService = {
      async acquireLock(cellId: string): Promise<boolean> {
        if (!lockManager) {
          const Manager = await loadLockManager();
          if (!Manager || !collaborationProvider.isCollaborating) {
            return true; // In single-user mode, always allow editing
          }
          lockManager = new Manager();
        }

        try {
          return await lockManager.acquireLock(cellId);
        } catch (error) {
          console.warn('Failed to acquire lock:', error);
          return false;
        }
      },

      async releaseLock(cellId: string): Promise<void> {
        if (lockManager) {
          try {
            await lockManager.releaseLock(cellId);
          } catch (error) {
            console.warn('Failed to release lock:', error);
          }
        }
      },

      isLocked(cellId: string): boolean {
        return lockManager ? lockManager.isLocked(cellId) : false;
      },

      getLockOwner(cellId: string): string | null {
        return lockManager ? lockManager.getLockOwner(cellId) : null;
      }
    };

    return service;
  }
};

/**
 * A plugin for the history service.
 * Manages document version history tracking and restoration capabilities.
 */
const historyService: JupyterFrontEndPlugin<IHistoryService> = {
  id: '@jupyter-notebook/notebook-extension:history-service',
  description: 'A plugin that provides document version history and restoration.',
  autoStart: true,
  requires: [ICollaborationProvider],
  optional: [ITranslator],
  provides: IHistoryService,
  activate: async (
    app: JupyterFrontEnd,
    collaborationProvider: ICollaborationProvider,
    translator: ITranslator | null
  ): Promise<IHistoryService> => {
    translator = translator ?? nullTranslator;

    let HistoryTracker: any = null;

    const loadHistoryTracker = async () => {
      if (!HistoryTracker) {
        try {
          const module = await import('../../../notebook/src/collab/history');
          HistoryTracker = module.ChangeHistoryTracker;
        } catch (error) {
          console.warn('History service not available:', error);
          return null;
        }
      }
      return HistoryTracker;
    };

    const service: IHistoryService = {
      async getHistory(notebook: NotebookPanel): Promise<any[]> {
        const Tracker = await loadHistoryTracker();
        if (!Tracker || !collaborationProvider.isCollaborating) {
          return []; // No history in single-user mode
        }

        try {
          const provider = collaborationProvider.getProvider(notebook);
          if (provider) {
            const tracker = new Tracker(provider);
            return tracker.getHistory();
          }
        } catch (error) {
          console.warn('Failed to retrieve history:', error);
        }
        return [];
      },

      async restoreVersion(notebook: NotebookPanel, versionId: string): Promise<void> {
        const Tracker = await loadHistoryTracker();
        if (!Tracker || !collaborationProvider.isCollaborating) {
          return;
        }

        try {
          const provider = collaborationProvider.getProvider(notebook);
          if (provider) {
            const tracker = new Tracker(provider);
            await tracker.restoreVersion(versionId);
          }
        } catch (error) {
          console.error('Failed to restore version:', error);
        }
      },

      async createSnapshot(notebook: NotebookPanel): Promise<string> {
        const Tracker = await loadHistoryTracker();
        if (!Tracker || !collaborationProvider.isCollaborating) {
          return '';
        }

        try {
          const provider = collaborationProvider.getProvider(notebook);
          if (provider) {
            const tracker = new Tracker(provider);
            return await tracker.createSnapshot();
          }
        } catch (error) {
          console.error('Failed to create snapshot:', error);
        }
        return '';
      }
    };

    return service;
  }
};

/**
 * A plugin for the permissions service.
 * Handles role-based access control (viewer, commenter, editor, owner).
 */
const permissionsService: JupyterFrontEndPlugin<IPermissionsService> = {
  id: '@jupyter-notebook/notebook-extension:permissions-service',
  description: 'A plugin that provides role-based access control for collaborative sessions.',
  autoStart: true,
  requires: [ICollaborationProvider],
  optional: [ITranslator],
  provides: IPermissionsService,
  activate: async (
    app: JupyterFrontEnd,
    collaborationProvider: ICollaborationProvider,
    translator: ITranslator | null
  ): Promise<IPermissionsService> => {
    translator = translator ?? nullTranslator;

    let PermissionsManager: any = null;

    const loadPermissionsManager = async () => {
      if (!PermissionsManager) {
        try {
          const module = await import('../../../notebook/src/collab/permissions');
          PermissionsManager = module.PermissionsManager;
        } catch (error) {
          console.warn('Permissions service not available:', error);
          return null;
        }
      }
      return PermissionsManager;
    };

    const service: IPermissionsService = {
      async getPermissions(notebook: NotebookPanel): Promise<any> {
        const Manager = await loadPermissionsManager();
        if (!Manager || !collaborationProvider.isCollaborating) {
          // In single-user mode, user has all permissions
          return { view: true, comment: true, edit: true, manage: true };
        }

        try {
          const provider = collaborationProvider.getProvider(notebook);
          if (provider) {
            const manager = new Manager(provider);
            return manager.getPermissions();
          }
        } catch (error) {
          console.warn('Failed to retrieve permissions:', error);
        }
        return { view: true, comment: false, edit: false, manage: false };
      },

      async setPermissions(notebook: NotebookPanel, permissions: any): Promise<void> {
        const Manager = await loadPermissionsManager();
        if (!Manager || !collaborationProvider.isCollaborating) {
          return;
        }

        try {
          const provider = collaborationProvider.getProvider(notebook);
          if (provider) {
            const manager = new Manager(provider);
            await manager.setPermissions(permissions);
          }
        } catch (error) {
          console.error('Failed to set permissions:', error);
        }
      },

      async hasPermission(notebook: NotebookPanel, permission: string): Promise<boolean> {
        const permissions = await this.getPermissions(notebook);
        return permissions[permission] || false;
      }
    };

    return service;
  }
};

/**
 * A plugin for the comment service.
 * Provides cell-level comment and discussion threading functionality.
 */
const commentService: JupyterFrontEndPlugin<ICommentService> = {
  id: '@jupyter-notebook/notebook-extension:comment-service',
  description: 'A plugin that provides cell-level comments and discussion threads.',
  autoStart: true,
  requires: [ICollaborationProvider],
  optional: [ITranslator],
  provides: ICommentService,
  activate: async (
    app: JupyterFrontEnd,
    collaborationProvider: ICollaborationProvider,
    translator: ITranslator | null
  ): Promise<ICommentService> => {
    translator = translator ?? nullTranslator;

    let CommentManager: any = null;

    const loadCommentManager = async () => {
      if (!CommentManager) {
        try {
          const module = await import('../../../notebook/src/collab/comments');
          CommentManager = module.CommentManager;
        } catch (error) {
          console.warn('Comment service not available:', error);
          return null;
        }
      }
      return CommentManager;
    };

    let commentManager: any = null;

    const service: ICommentService = {
      async getComments(cellId: string): Promise<any[]> {
        if (!commentManager) {
          const Manager = await loadCommentManager();
          if (!Manager || !collaborationProvider.isCollaborating) {
            return []; // No comments in single-user mode
          }
          commentManager = new Manager();
        }

        try {
          return commentManager.getComments(cellId);
        } catch (error) {
          console.warn('Failed to retrieve comments:', error);
          return [];
        }
      },

      async addComment(cellId: string, content: string): Promise<string> {
        if (!commentManager) {
          const Manager = await loadCommentManager();
          if (!Manager || !collaborationProvider.isCollaborating) {
            return ''; // No commenting in single-user mode
          }
          commentManager = new Manager();
        }

        try {
          return await commentManager.addComment(cellId, content);
        } catch (error) {
          console.error('Failed to add comment:', error);
          return '';
        }
      },

      async resolveComment(commentId: string): Promise<void> {
        if (commentManager) {
          try {
            await commentManager.resolveComment(commentId);
          } catch (error) {
            console.error('Failed to resolve comment:', error);
          }
        }
      }
    };

    return service;
  }
};

/**
 * A plugin for the collaboration UI components.
 * Integrates collaboration UI components with conditional rendering based on service availability.
 */
const collaborationUI: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:collaboration-ui',
  description: 'A plugin that provides collaborative editing UI components.',
  autoStart: true,
  requires: [INotebookTracker, INotebookShell],
  optional: [
    ICollaborationProvider,
    IAwarenessService,
    ILockService,
    IHistoryService,
    IPermissionsService,
    ICommentService,
    ITranslator,
    IToolbarWidgetRegistry
  ],
  activate: async (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    shell: INotebookShell,
    collaborationProvider?: ICollaborationProvider,
    awarenessService?: IAwarenessService,
    lockService?: ILockService,
    historyService?: IHistoryService,
    permissionsService?: IPermissionsService,
    commentService?: ICommentService,
    translator?: ITranslator,
    toolbarRegistry?: IToolbarWidgetRegistry
  ): Promise<void> => {
    translator = translator ?? nullTranslator;
    const trans = translator.load('notebook');

    // Lazy load UI components
    let CollaborationBar: any = null;
    let UserPresence: any = null;
    let CellLockIndicator: any = null;
    let HistoryViewer: any = null;
    let PermissionsDialog: any = null;
    let CommentSystem: any = null;

    const loadUIComponents = async () => {
      try {
        const [
          collaborationBarModule,
          userPresenceModule,
          cellLockModule,
          historyModule,
          permissionsModule,
          commentModule
        ] = await Promise.all([
          import('./components/collaborationBar'),
          import('./components/userPresence'),
          import('./components/cellLockIndicator'),
          import('./components/historyViewer'),
          import('./components/permissionsDialog'),
          import('./components/commentSystem')
        ]);

        CollaborationBar = collaborationBarModule.CollaborationBar;
        UserPresence = userPresenceModule.UserPresence;
        CellLockIndicator = cellLockModule.CellLockIndicator;
        HistoryViewer = historyModule.HistoryViewer;
        PermissionsDialog = permissionsModule.PermissionsDialog;
        CommentSystem = commentModule.CommentSystem;

        return true;
      } catch (error) {
        console.warn('Collaboration UI components not available:', error);
        return false;
      }
    };

    // Track when collaboration is active
    const activeCollaborationSessions = new Set<NotebookPanel>();

    const setupCollaborationUI = async (notebook: NotebookPanel) => {
      // Only setup UI if collaboration services are available
      if (!collaborationProvider || !collaborationProvider.isCollaborating) {
        return;
      }

      const componentsLoaded = await loadUIComponents();
      if (!componentsLoaded) {
        return;
      }

      try {
        // Enable collaboration for this notebook
        await collaborationProvider.enableCollaboration(notebook);
        activeCollaborationSessions.add(notebook);

        // Setup awareness tracking
        if (awarenessService) {
          await awarenessService.trackAwareness(notebook);
        }

        // Add collaboration bar to toolbar if available
        if (toolbarRegistry && CollaborationBar) {
          toolbarRegistry.addFactory('TopBar', 'collaboration', (toolbar) => {
            const widget = ReactWidget.create(
              CollaborationBar({
                notebook,
                collaborationProvider,
                awarenessService,
                lockService,
                permissionsService,
                translator
              })
            );
            widget.id = DOMUtils.createDomID();
            widget.addClass('jp-CollaborationBar');
            return widget;
          });
        }

        // Add user presence indicators
        if (UserPresence) {
          const presenceWidget = ReactWidget.create(
            UserPresence({
              notebook,
              awarenessService,
              translator
            })
          );
          presenceWidget.addClass('jp-UserPresence');
          shell.add(presenceWidget, 'top', { rank: 1000 });
        }

        // Setup cell lock indicators
        if (CellLockIndicator && lockService) {
          notebook.content.widgets.forEach((cell, index) => {
            const lockIndicator = ReactWidget.create(
              CellLockIndicator({
                cellId: cell.model.id,
                lockService,
                translator
              })
            );
            lockIndicator.addClass('jp-CellLockIndicator');
            // Add to cell toolbar if available
          });
        }

        // Add history viewer panel
        if (HistoryViewer && historyService) {
          const historyWidget = ReactWidget.create(
            HistoryViewer({
              notebook,
              historyService,
              translator
            })
          );
          historyWidget.title.label = trans.__('History');
          historyWidget.title.iconClass = 'jp-Icon jp-Icon-16 jp-HistoryIcon';
          historyWidget.addClass('jp-HistoryViewer');
          // Add to right sidebar
          shell.add(historyWidget, 'right', { type: 'History Viewer' });
        }

        // Add comment system
        if (CommentSystem && commentService) {
          const commentWidget = ReactWidget.create(
            CommentSystem({
              notebook,
              commentService,
              translator
            })
          );
          commentWidget.title.label = trans.__('Comments');
          commentWidget.title.iconClass = 'jp-Icon jp-Icon-16 jp-CommentIcon';
          commentWidget.addClass('jp-CommentSystem');
          // Add to right sidebar
          shell.add(commentWidget, 'right', { type: 'Comments' });
        }

        // Setup permissions dialog command
        if (PermissionsDialog && permissionsService) {
          const commandId = 'collaboration:open-permissions';
          
          if (!app.commands.hasCommand(commandId)) {
            app.commands.addCommand(commandId, {
              label: trans.__('Manage Permissions'),
              execute: () => {
                const dialog = ReactWidget.create(
                  PermissionsDialog({
                    notebook,
                    permissionsService,
                    translator
                  })
                );
                dialog.addClass('jp-PermissionsDialog');
                // Show dialog
              },
              isEnabled: () => {
                const current = tracker.currentWidget;
                return current === notebook && activeCollaborationSessions.has(notebook);
              }
            });
          }
        }

        // Clean up on notebook disposal
        notebook.disposed.connect(() => {
          activeCollaborationSessions.delete(notebook);
          if (awarenessService) {
            awarenessService.stopTracking(notebook);
          }
          if (collaborationProvider) {
            collaborationProvider.disableCollaboration(notebook);
          }
        });

      } catch (error) {
        console.error('Failed to setup collaboration UI:', error);
        // Graceful fallback - continue without collaboration UI
      }
    };

    // Setup collaboration when notebooks are opened
    tracker.widgetAdded.connect(async (sender, notebook) => {
      await notebook.context.ready;
      
      // Check if collaboration should be enabled (could be based on URL params, settings, etc.)
      const shouldEnableCollaboration = checkCollaborationSettings();
      
      if (shouldEnableCollaboration && collaborationProvider) {
        await setupCollaborationUI(notebook);
      }
    });

    // Handle existing notebooks
    tracker.forEach(async (notebook) => {
      if (notebook.context.isReady) {
        const shouldEnableCollaboration = checkCollaborationSettings();
        if (shouldEnableCollaboration && collaborationProvider) {
          await setupCollaborationUI(notebook);
        }
      }
    });

    /**
     * Check if collaboration should be enabled based on settings or URL parameters.
     * This provides a way to control when collaboration features are activated.
     */
    function checkCollaborationSettings(): boolean {
      // Check URL parameters
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('collaborate')) {
        return urlParams.get('collaborate') === 'true';
      }

      // Check if collaboration backend is available
      // This could include pinging a collaboration endpoint
      try {
        // Simple check - if collaboration services are available, enable collaboration
        return Boolean(collaborationProvider && awarenessService);
      } catch (error) {
        return false;
      }
    }
  }
};

/**
 * A plugin for collaboration activation lifecycle management.
 * Provides commands and UI for enabling/disabling collaboration features.
 */
const collaborationLifecycle: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:collaboration-lifecycle',
  description: 'A plugin that manages collaboration activation lifecycle with graceful fallbacks.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ICollaborationProvider, ICommandPalette, IMainMenu, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    collaborationProvider?: ICollaborationProvider,
    palette?: ICommandPalette,
    mainMenu?: IMainMenu,
    translator?: ITranslator
  ): void => {
    translator = translator ?? nullTranslator;
    const trans = translator.load('notebook');

    // Add collaboration commands
    const enableCollaborationCommand = 'collaboration:enable';
    const disableCollaborationCommand = 'collaboration:disable';
    const toggleCollaborationCommand = 'collaboration:toggle';

    app.commands.addCommand(enableCollaborationCommand, {
      label: trans.__('Enable Collaboration'),
      execute: async () => {
        const current = tracker.currentWidget;
        if (current && collaborationProvider) {
          try {
            await collaborationProvider.enableCollaboration(current);
            console.log('Collaboration enabled successfully');
          } catch (error) {
            console.error('Failed to enable collaboration:', error);
            // Show user-friendly error message
          }
        }
      },
      isEnabled: () => {
        const current = tracker.currentWidget;
        return Boolean(
          current && 
          collaborationProvider && 
          !collaborationProvider.isCollaborating
        );
      }
    });

    app.commands.addCommand(disableCollaborationCommand, {
      label: trans.__('Disable Collaboration'),
      execute: async () => {
        const current = tracker.currentWidget;
        if (current && collaborationProvider) {
          try {
            await collaborationProvider.disableCollaboration(current);
            console.log('Collaboration disabled successfully');
          } catch (error) {
            console.error('Failed to disable collaboration:', error);
          }
        }
      },
      isEnabled: () => {
        const current = tracker.currentWidget;
        return Boolean(
          current && 
          collaborationProvider && 
          collaborationProvider.isCollaborating
        );
      }
    });

    app.commands.addCommand(toggleCollaborationCommand, {
      label: trans.__('Toggle Collaboration'),
      execute: async () => {
        if (collaborationProvider?.isCollaborating) {
          await app.commands.execute(disableCollaborationCommand);
        } else {
          await app.commands.execute(enableCollaborationCommand);
        }
      },
      isEnabled: () => {
        const current = tracker.currentWidget;
        return Boolean(current && collaborationProvider);
      },
      isToggled: () => {
        return Boolean(collaborationProvider?.isCollaborating);
      }
    });

    // Add to command palette
    if (palette) {
      palette.addItem({
        command: enableCollaborationCommand,
        category: 'Collaboration',
      });
      palette.addItem({
        command: disableCollaborationCommand,
        category: 'Collaboration',
      });
      palette.addItem({
        command: toggleCollaborationCommand,
        category: 'Collaboration',
      });
    }

    // Add to main menu if available
    if (mainMenu) {
      mainMenu.fileMenu.newMenu.addGroup([
        { command: toggleCollaborationCommand }
      ], 1000);
    }

    // Monitor connection status and provide fallbacks
    if (collaborationProvider) {
      // Set up periodic health checks
      const healthCheckInterval = setInterval(async () => {
        try {
          // This would check if the collaboration backend is still available
          // For now, we'll assume it's always available if the provider exists
        } catch (error) {
          console.warn('Collaboration backend health check failed:', error);
          // Could trigger fallback to offline mode here
        }
      }, 30000); // Check every 30 seconds

      // Clean up interval on app disposal
      app.restored.then(() => {
        window.addEventListener('beforeunload', () => {
          clearInterval(healthCheckInterval);
        });
      });
    }
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
  // Collaboration plugins with lazy loading and graceful fallbacks
  collaborationProvider,
  awarenessService,
  lockService,
  historyService,
  permissionsService,
  commentService,
  collaborationUI,
  collaborationLifecycle,
];

export default plugins;
