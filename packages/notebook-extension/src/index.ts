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

// Collaboration imports
import {
  IYjsNotebookProvider,
  IAwarenessSystem,
  ICollaborationPermissions,
  ICollaborationService,
  ICollaborationToolbar,
  ILockManager,
  ICommentSystem,
} from '@jupyter-notebook/application';

// Collaboration UI components - imported dynamically for graceful degradation
let CollaborationToolbar: any;
let PermissionDialog: any;
let CommentThread: any;
let CommentForm: any;
let CommentList: any;
let CommentResolver: any;

// Import collaboration components with error handling
try {
  CollaborationToolbar = require('./toolbar').CollaborationToolbar;
} catch (e) {
  console.warn('CollaborationToolbar component not available');
}

try {
  PermissionDialog = require('./permissions').PermissionDialog;
} catch (e) {
  console.warn('PermissionDialog component not available');
}

try {
  CommentThread = require('./comments/CommentThread').CommentThread;
} catch (e) {
  console.warn('CommentThread component not available');
}

try {
  CommentForm = require('./comments/CommentForm').CommentForm;
} catch (e) {
  console.warn('CommentForm component not available');
}

try {
  CommentList = require('./comments/CommentList').CommentList;
} catch (e) {
  console.warn('CommentList component not available');
}

try {
  CommentResolver = require('./comments/CommentResolver').CommentResolver;
} catch (e) {
  console.warn('CommentResolver component not available');
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

  /**
   * A command to manage collaboration permissions
   */
  export const manageCollaborationPermissions = 'notebook:manage-collaboration-permissions';

  /**
   * A command to add a comment to a cell
   */
  export const addCellComment = 'notebook:add-cell-comment';

  /**
   * A command to show collaboration status
   */
  export const showCollaborationStatus = 'notebook:show-collaboration-status';
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
 * A plugin for the collaboration toolbar
 */
const collaborationToolbar: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:collaboration-toolbar',
  description: 'A plugin for the collaboration toolbar.',
  autoStart: true,
  requires: [INotebookShell, INotebookTracker, ITranslator],
  optional: [IToolbarWidgetRegistry, ICollaborationService, IAwarenessSystem, ICollaborationPermissions],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    tracker: INotebookTracker,
    translator: ITranslator,
    toolbarRegistry: IToolbarWidgetRegistry | null,
    collaborationService: ICollaborationService | null,
    awarenessSystem: IAwarenessSystem | null,
    permissions: ICollaborationPermissions | null
  ) => {
    const trans = translator.load('notebook');

    // Only activate if collaboration is enabled and toolbar registry is available
    if (!toolbarRegistry || !collaborationService || !collaborationService.isCollaborationEnabled()) {
      return;
    }

    const onChange = async () => {
      const current = shell.currentWidget;
      if (!(current instanceof NotebookPanel)) {
        return;
      }

      // Check if collaboration is available for this notebook
      const status = collaborationService.getStatus();
      if (status === 'error' || status === 'disabled') {
        return;
      }

      // Register the collaboration toolbar factory if not already registered
      if (toolbarRegistry && CollaborationToolbar) {
        try {
          // Check if factory is already registered (avoid duplicate registration)
          const hasFactory = (toolbarRegistry as any).hasFactory && 
                            (toolbarRegistry as any).hasFactory('TopBar', 'collaboration');
          
          if (!hasFactory) {
            toolbarRegistry.addFactory('TopBar', 'collaboration', (toolbar) => {
              const widget = CollaborationToolbar.create({
                translator,
                awarenessSystem,
                permissions,
                collaborationService,
              });
              widget.id = DOMUtils.createDomID();
              widget.addClass('jp-NotebookCollaborationToolbar');
              return widget;
            });
          }
        } catch (error) {
          console.warn('Failed to register collaboration toolbar:', error);
        }
      }
    };

    // Monitor notebook changes and collaboration status
    shell.currentChanged.connect(onChange);
    if (collaborationService) {
      // Listen for collaboration status changes to show/hide toolbar
      app.started.then(() => {
        onChange();
      });
    }
  },
};

/**
 * A plugin for the comment system integration
 */
const commentSystem: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:comment-system',
  description: 'A plugin for the collaborative comment system.',
  autoStart: true,
  requires: [INotebookShell, INotebookTracker, ITranslator],
  optional: [ICommentSystem, ICollaborationService, ICollaborationPermissions, ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    tracker: INotebookTracker,
    translator: ITranslator,
    commentSystem: ICommentSystem | null,
    collaborationService: ICollaborationService | null,
    permissions: ICollaborationPermissions | null,
    palette: ICommandPalette | null
  ) => {
    // Only activate if collaboration is enabled and comment system is available
    if (!commentSystem || !collaborationService || !collaborationService.isCollaborationEnabled()) {
      return;
    }

    const trans = translator.load('notebook');

    const setupCommentIntegration = (notebook: NotebookPanel) => {
      // Add comment capabilities to each cell
      const setupCellComments = () => {
        notebook.content.widgets.forEach((cell, index) => {
          const cellId = cell.model.id;
          
          // Check if user has permission to add comments
          if (permissions && !permissions.canPerformOperation('add_comment')) {
            return;
          }

          // Create comment indicator if there are comments
          const commentCount = commentSystem.getUnresolvedCommentCount(cellId);
          if (commentCount > 0) {
            const indicator = document.createElement('div');
            indicator.className = 'jp-NotebookCell-commentIndicator';
            indicator.textContent = `${commentCount}`;
            indicator.title = trans.__('Click to view comments');
            
            // Add click handler to show comment thread
            indicator.addEventListener('click', () => {
              const comments = commentSystem.getComments(cellId);
              if (comments.length > 0 && CommentThread) {
                CommentThread.showDialog({
                  cellId,
                  comments,
                  commentSystem,
                  translator,
                  permissions,
                });
              }
            });
            
            cell.node.appendChild(indicator);
          }

          // Add context menu option for adding comments
          cell.node.addEventListener('contextmenu', (event) => {
            // Add comment option to context menu
            // This would be implemented through command palette integration
          });
        });
      };

      // Setup comments when notebook is ready
      notebook.context.ready.then(setupCellComments);
      
      // Re-setup when cells change
      notebook.model?.cells.changed.connect(() => {
        setupCellComments();
      });
    };

    const onChange = async () => {
      const current = shell.currentWidget;
      if (!(current instanceof NotebookPanel)) {
        return;
      }

      // Only setup if in collaborative mode
      const status = collaborationService.getStatus();
      if (status === 'connected' || status === 'connecting') {
        setupCommentIntegration(current);
      }
    };

    shell.currentChanged.connect(onChange);
    tracker.currentChanged.connect(() => {
      onChange();
    });
  },
};

/**
 * A plugin for permissions dialog management
 */
const permissionDialog: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:permission-dialog',
  description: 'A plugin for managing collaboration permissions.',
  autoStart: true,
  requires: [ITranslator],
  optional: [ICollaborationPermissions, ICollaborationService, ICommandPalette],
  activate: (
    app: JupyterFrontEnd,
    translator: ITranslator,
    permissions: ICollaborationPermissions | null,
    collaborationService: ICollaborationService | null,
    palette: ICommandPalette | null
  ) => {
    // Only activate if collaboration is enabled and user has admin permissions
    if (!permissions || !collaborationService || !collaborationService.isCollaborationEnabled()) {
      return;
    }

    const trans = translator.load('notebook');
    const { commands } = app;

    // Add command to open permission dialog
    commands.addCommand(CommandIDs.manageCollaborationPermissions, {
      label: trans.__('Manage Collaboration Permissions'),
      execute: async () => {
        if (!permissions.canPerformOperation('manage_users')) {
          // Show error message if user doesn't have permission
          return;
        }

        // Show permission dialog
        if (PermissionDialog) {
          await PermissionDialog.showDialog({
            permissions,
            collaborationService,
            translator,
          });
        } else {
          console.warn('PermissionDialog component not available');
        }
      },
      isEnabled: () => {
        return permissions.hasPermission('manage_permissions') && 
               collaborationService.getStatus() === 'connected';
      },
      isVisible: () => {
        return collaborationService.isCollaborationEnabled() &&
               permissions.getUserRole() === 'admin';
      },
    });

    // Add to command palette if available
    if (palette) {
      palette.addItem({
        command: CommandIDs.manageCollaborationPermissions,
        category: 'Collaboration',
      });
    }
  },
};

/**
 * Main collaboration coordination plugin
 */
const collaboration: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:collaboration',
  description: 'Main collaboration coordination plugin.',
  autoStart: true,
  requires: [INotebookShell, INotebookTracker, ITranslator],
  optional: [
    ICollaborationService,
    IYjsNotebookProvider,
    IAwarenessSystem,
    ILockManager,
    ICommentSystem,
    ICollaborationPermissions,
    ICommandPalette,
  ],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    tracker: INotebookTracker,
    translator: ITranslator,
    collaborationService: ICollaborationService | null,
    yjsProvider: IYjsNotebookProvider | null,
    awarenessSystem: IAwarenessSystem | null,
    lockManager: ILockManager | null,
    commentSystem: ICommentSystem | null,
    permissions: ICollaborationPermissions | null,
    palette: ICommandPalette | null
  ) => {
    // Main collaboration coordination logic
    const trans = translator.load('notebook');
    const { commands } = app;

    // Add command to show collaboration status
    commands.addCommand(CommandIDs.showCollaborationStatus, {
      label: trans.__('Show Collaboration Status'),
      execute: async () => {
        if (!collaborationService) {
          console.log('Collaboration not available');
          return;
        }

        const status = collaborationService.getStatus();
        const session = collaborationService.getCurrentSession();
        
        let message = `Collaboration Status: ${status}`;
        if (session) {
          message += `\nRoom: ${session.roomId}\nUsers: ${session.userCount}\nStarted: ${session.startTime.toLocaleString()}`;
        }
        
        console.log(message);
        // TODO: Show status in a dialog or status bar
      },
      isVisible: () => {
        return collaborationService?.isCollaborationEnabled() === true;
      },
    });

    // Add to command palette if available
    if (palette) {
      palette.addItem({
        command: CommandIDs.showCollaborationStatus,
        category: 'Collaboration',
      });
    }
    const { commands } = app;

    // Add command to add comment to current cell
    commands.addCommand(CommandIDs.addCellComment, {
      label: trans.__('Add Comment to Cell'),
      execute: async () => {
        const current = tracker.currentWidget;
        if (!(current instanceof NotebookPanel)) {
          return;
        }

        const activeCell = current.content.activeCell;
        if (!activeCell) {
          return;
        }

        if (!permissions?.canPerformOperation('add_comment')) {
          return;
        }

        // Show comment form dialog
        if (CommentForm) {
          const result = await CommentForm.showDialog({
            cellId: activeCell.model.id,
            commentSystem,
            translator,
          });

          if (result && result.value) {
            await commentSystem.addComment(activeCell.model.id, result.value);
          }
        } else {
          console.warn('CommentForm component not available');
        }
      },
      isEnabled: () => {
        const current = tracker.currentWidget;
        return current instanceof NotebookPanel && 
               current.content.activeCell !== null &&
               permissions?.canPerformOperation('add_comment') === true;
      },
      isVisible: () => {
        return collaborationService?.isCollaborationEnabled() === true;
      },
    });

    // Add to command palette if available
    if (palette) {
      palette.addItem({
        command: CommandIDs.addCellComment,
        category: 'Collaboration',
      });
    }

    // Feature flag check - only activate if collaboration service is available
    if (!collaborationService) {
      console.log('Collaboration service not available - running in single-user mode');
      return;
    }

    const enableCollaborationForNotebook = async (notebook: NotebookPanel) => {
      try {
        // Check if collaboration is enabled
        if (!collaborationService.isCollaborationEnabled()) {
          return;
        }

        await notebook.context.ready;
        const model = notebook.model;
        if (!model || !yjsProvider) {
          return;
        }

        // Generate room ID based on notebook path
        const roomId = notebook.context.path;
        
        // Enable collaboration for this notebook
        await yjsProvider.enableCollaboration(model, roomId);
        await collaborationService.joinSession(roomId, model);

        // Setup awareness system
        if (awarenessSystem) {
          // Track cursor and selection changes
          notebook.content.activeCell?.editor?.model.selections.changed.connect(() => {
            const activeCell = notebook.content.activeCell;
            if (activeCell) {
              const cellId = activeCell.model.id;
              const editor = activeCell.editor;
              if (editor) {
                const cursor = editor.getCursorPosition();
                awarenessSystem.setCursorPosition(cellId, cursor.offset);
                
                // Track selections
                const selection = editor.getSelection();
                if (selection.start !== selection.end) {
                  awarenessSystem.setSelection(cellId, selection.start, selection.end);
                }
              }
            }
          });

          // Track active cell changes
          notebook.content.activeCellChanged.connect((sender, cell) => {
            if (cell) {
              awarenessSystem.setActiveCell(cell.model.id);
            }
          });
        }

        // Setup lock manager
        if (lockManager) {
          notebook.content.activeCellChanged.connect(async (sender, cell) => {
            if (cell && permissions?.canPerformOperation('edit_cell')) {
              // Try to acquire lock when cell becomes active
              const lockAcquired = await lockManager.acquireLock(cell.model.id);
              if (!lockAcquired) {
                // Show lock conflict message
                const owner = lockManager.getLockOwner(cell.model.id);
                console.log(`Cell is locked by ${owner}`);
              }
            }
          });

          // Release locks when cell becomes inactive
          tracker.currentChanged.connect(() => {
            const current = tracker.currentWidget;
            if (current && current !== notebook) {
              lockManager.releaseAllLocks();
            }
          });
        }

        console.log(`Collaboration enabled for notebook: ${roomId}`);
      } catch (error) {
        console.warn('Failed to enable collaboration:', error);
        // Graceful degradation - continue in single-user mode
      }
    };

    const onChange = async () => {
      const current = shell.currentWidget;
      if (!(current instanceof NotebookPanel)) {
        return;
      }

      // Enable collaboration for the current notebook
      await enableCollaborationForNotebook(current);
    };

    // Setup collaboration when notebooks are opened
    shell.currentChanged.connect(onChange);
    tracker.widgetAdded.connect((sender, notebook) => {
      enableCollaborationForNotebook(notebook);
    });

    console.log('Collaboration plugin activated');
  },
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
  // Collaboration plugins
  collaboration,
  collaborationToolbar,
  commentSystem,
  permissionDialog,
];

export default plugins;
