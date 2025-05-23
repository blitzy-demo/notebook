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

// Import new collaboration UI components
import { UserPresenceComponent } from './components/userPresence';
import { CellLockIndicatorComponent } from './components/cellLockIndicator';
import { HistoryViewerComponent } from './components/historyViewer';
import { PermissionsDialogComponent } from './components/permissionsDialog';
import { CommentSystemComponent } from './components/commentSystem';
import { CollaborationBarComponent } from './components/collaborationBar';

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
   * A command to toggle the collaboration bar
   */
  export const toggleCollaborationBar = 'notebook:toggle-collaboration-bar';

  /**
   * A command to show the permissions dialog
   */
  export const showPermissionsDialog = 'notebook:show-permissions-dialog';

  /**
   * A command to show the history viewer
   */
  export const showHistoryViewer = 'notebook:show-history-viewer';

  /**
   * A command to toggle cell locking
   */
  export const toggleCellLock = 'notebook:toggle-cell-lock';

  /**
   * A command to add a comment to the current cell
   */
  export const addCellComment = 'notebook:add-cell-comment';

  /**
   * A command to show all comments
   */
  export const showAllComments = 'notebook:show-all-comments';
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
      label: trans.__('Open\u2026'),
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
 * A plugin to add the collaboration bar to the notebook
 */
const collaborationBar: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:collaboration-bar',
  description: 'A plugin to add the collaboration bar to the notebook.',
  autoStart: true,
  requires: [INotebookShell, INotebookTracker],
  optional: [ICommandPalette, ITranslator, IToolbarWidgetRegistry],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    tracker: INotebookTracker,
    palette: ICommandPalette | null,
    translator: ITranslator | null,
    toolbarRegistry: IToolbarWidgetRegistry | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    const { commands } = app;
    let collaborationBarVisible = true;

    // Add the collaboration bar toggle command
    commands.addCommand(CommandIDs.toggleCollaborationBar, {
      label: trans.__('Toggle Collaboration Bar'),
      execute: () => {
        collaborationBarVisible = !collaborationBarVisible;
        const current = tracker.currentWidget;
        if (!current) {
          return;
        }
        
        // Find the collaboration bar widget and toggle its visibility
        const collaborationBar = shell.widgets('collaboration-bar').next();
        if (collaborationBar) {
          collaborationBar.setHidden(!collaborationBarVisible);
        }
      },
      isEnabled: () => tracker.currentWidget !== null,
      isToggled: () => collaborationBarVisible
    });

    if (palette) {
      palette.addItem({
        command: CommandIDs.toggleCollaborationBar,
        category: 'Collaboration'
      });
    }

    // Add the collaboration bar to the toolbar if available
    if (toolbarRegistry) {
      toolbarRegistry.addFactory('TopBar', 'collaboration', (toolbar) => {
        const widget = new Widget();
        widget.addClass('jp-NotebookCollaborationButton');
        widget.node.title = trans.__('Toggle Collaboration Bar');
        widget.node.onclick = () => {
          commands.execute(CommandIDs.toggleCollaborationBar);
        };
        return widget;
      });
    }

    // Add the collaboration bar when a notebook is opened
    const onChange = async () => {
      const current = shell.currentWidget;
      if (!(current instanceof NotebookPanel)) {
        return;
      }

      await current.sessionContext.ready;
      
      // Create and add the collaboration bar component
      const collaborationBarWidget = CollaborationBarComponent.create({
        notebook: current.content,
        translator: translator ?? nullTranslator
      });
      
      shell.add(collaborationBarWidget, 'collaboration-bar', {
        rank: 1000
      });
      
      // Set initial visibility based on the toggle state
      collaborationBarWidget.setHidden(!collaborationBarVisible);
    };

    shell.currentChanged.connect(onChange);
  }
};

/**
 * A plugin to add user presence indicators to the notebook
 */
const userPresence: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:user-presence',
  description: 'A plugin to add user presence indicators to the notebook.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');

    // Add user presence indicators when a notebook is opened
    tracker.widgetAdded.connect((sender, notebook) => {
      notebook.sessionContext.ready.then(() => {
        // Create and add the user presence component
        const userPresenceWidget = UserPresenceComponent.create({
          notebook: notebook.content,
          translator: translator ?? nullTranslator
        });
        
        // Attach the user presence widget to the notebook
        notebook.content.node.appendChild(userPresenceWidget.node);
      });
    });
  }
};

/**
 * A plugin to add cell lock indicators to the notebook
 */
const cellLockIndicator: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:cell-lock-indicator',
  description: 'A plugin to add cell lock indicators to the notebook.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    const { commands } = app;

    // Add the toggle cell lock command
    commands.addCommand(CommandIDs.toggleCellLock, {
      label: trans.__('Toggle Cell Lock'),
      execute: () => {
        const current = tracker.currentWidget;
        if (!current) {
          return;
        }
        
        const activeCell = current.content.activeCell;
        if (!activeCell) {
          return;
        }
        
        // The actual locking logic is handled by the cell lock indicator component
        // This command just triggers the toggle event
        const event = new CustomEvent('toggle-cell-lock', {
          bubbles: true,
          detail: { cellId: activeCell.model.id }
        });
        activeCell.node.dispatchEvent(event);
      },
      isEnabled: () => {
        const current = tracker.currentWidget;
        return current !== null && current.content.activeCell !== null;
      }
    });

    if (palette) {
      palette.addItem({
        command: CommandIDs.toggleCellLock,
        category: 'Collaboration'
      });
    }

    // Add cell lock indicators when a notebook is opened
    tracker.widgetAdded.connect((sender, notebook) => {
      notebook.sessionContext.ready.then(() => {
        // Create and add the cell lock indicator component for each cell
        notebook.content.widgets.forEach(cell => {
          const cellLockWidget = CellLockIndicatorComponent.create({
            cell,
            translator: translator ?? nullTranslator
          });
          
          // Attach the cell lock indicator to the cell
          cell.node.appendChild(cellLockWidget.node);
        });
        
        // Handle new cells being added
        notebook.model?.cells.changed.connect((sender, args) => {
          if (args.type === 'add') {
            args.newValues.forEach((model, index) => {
              const cell = notebook.content.widgets[args.newIndex + index];
              const cellLockWidget = CellLockIndicatorComponent.create({
                cell,
                translator: translator ?? nullTranslator
              });
              
              cell.node.appendChild(cellLockWidget.node);
            });
          }
        });
      });
    });
  }
};

/**
 * A plugin to add the history viewer to the notebook
 */
const historyViewer: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:history-viewer',
  description: 'A plugin to add the history viewer to the notebook.',
  autoStart: true,
  requires: [INotebookShell, INotebookTracker],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    tracker: INotebookTracker,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    const { commands } = app;

    // Add the show history viewer command
    commands.addCommand(CommandIDs.showHistoryViewer, {
      label: trans.__('Show Version History'),
      execute: () => {
        const current = tracker.currentWidget;
        if (!current) {
          return;
        }
        
        // Create and show the history viewer
        const historyViewerWidget = HistoryViewerComponent.create({
          notebook: current.content,
          translator: translator ?? nullTranslator
        });
        
        shell.add(historyViewerWidget, 'right', {
          rank: 1000,
          type: 'History Viewer'
        });
      },
      isEnabled: () => tracker.currentWidget !== null
    });

    if (palette) {
      palette.addItem({
        command: CommandIDs.showHistoryViewer,
        category: 'Collaboration'
      });
    }
  }
};

/**
 * A plugin to add the permissions dialog to the notebook
 */
const permissionsDialog: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:permissions-dialog',
  description: 'A plugin to add the permissions dialog to the notebook.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    const { commands } = app;

    // Add the show permissions dialog command
    commands.addCommand(CommandIDs.showPermissionsDialog, {
      label: trans.__('Manage Permissions'),
      execute: () => {
        const current = tracker.currentWidget;
        if (!current) {
          return;
        }
        
        // Create and show the permissions dialog
        PermissionsDialogComponent.createAndShow({
          notebook: current.content,
          translator: translator ?? nullTranslator
        });
      },
      isEnabled: () => tracker.currentWidget !== null
    });

    if (palette) {
      palette.addItem({
        command: CommandIDs.showPermissionsDialog,
        category: 'Collaboration'
      });
    }
  }
};

/**
 * A plugin to add the comment system to the notebook
 */
const commentSystem: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:comment-system',
  description: 'A plugin to add the comment system to the notebook.',
  autoStart: true,
  requires: [INotebookTracker],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    const { commands } = app;

    // Add the add cell comment command
    commands.addCommand(CommandIDs.addCellComment, {
      label: trans.__('Add Comment to Cell'),
      execute: () => {
        const current = tracker.currentWidget;
        if (!current) {
          return;
        }
        
        const activeCell = current.content.activeCell;
        if (!activeCell) {
          return;
        }
        
        // Trigger the add comment event
        const event = new CustomEvent('add-cell-comment', {
          bubbles: true,
          detail: { cellId: activeCell.model.id }
        });
        activeCell.node.dispatchEvent(event);
      },
      isEnabled: () => {
        const current = tracker.currentWidget;
        return current !== null && current.content.activeCell !== null;
      }
    });

    // Add the show all comments command
    commands.addCommand(CommandIDs.showAllComments, {
      label: trans.__('Show All Comments'),
      execute: () => {
        const current = tracker.currentWidget;
        if (!current) {
          return;
        }
        
        // Create and show the comment system component
        const commentSystemWidget = CommentSystemComponent.create({
          notebook: current.content,
          translator: translator ?? nullTranslator,
          showAll: true
        });
        
        // The comment system will be shown in a dialog
        commentSystemWidget.show();
      },
      isEnabled: () => tracker.currentWidget !== null
    });

    if (palette) {
      palette.addItem({
        command: CommandIDs.addCellComment,
        category: 'Collaboration'
      });
      
      palette.addItem({
        command: CommandIDs.showAllComments,
        category: 'Collaboration'
      });
    }

    // Add comment system components when a notebook is opened
    tracker.widgetAdded.connect((sender, notebook) => {
      notebook.sessionContext.ready.then(() => {
        // Create and add the comment system component for each cell
        notebook.content.widgets.forEach(cell => {
          const commentWidget = CommentSystemComponent.create({
            cell,
            translator: translator ?? nullTranslator
          });
          
          // Attach the comment system to the cell
          cell.node.appendChild(commentWidget.node);
        });
        
        // Handle new cells being added
        notebook.model?.cells.changed.connect((sender, args) => {
          if (args.type === 'add') {
            args.newValues.forEach((model, index) => {
              const cell = notebook.content.widgets[args.newIndex + index];
              const commentWidget = CommentSystemComponent.create({
                cell,
                translator: translator ?? nullTranslator
              });
              
              cell.node.appendChild(commentWidget.node);
            });
          }
        });
      });
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
  // Add new collaboration plugins
  collaborationBar,
  userPresence,
  cellLockIndicator,
  historyViewer,
  permissionsDialog,
  commentSystem
];

export default plugins;