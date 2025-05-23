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

// Import collaboration UI components
import { UserPresence } from './components/userPresence';
import { CellLockIndicator } from './components/cellLockIndicator';
import { HistoryViewer } from './components/historyViewer';
import { PermissionsDialog } from './components/permissionsDialog';
import { CommentSystem } from './components/commentSystem';
import { CollaborationBar } from './components/collaborationBar';

// Import collaboration service interfaces
import {
  IAwarenessService,
  ILockService,
  IHistoryService,
  IPermissionsService,
  ICommentService,
  ICollaborationService
} from '@jupyter-notebook/application';

import { TrustedComponent } from './trusted';

/**
 * A plugin to add the collaboration bar to the notebook interface.
 */
const collaborationBarPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:collaboration-bar',
  description: 'A plugin that adds a collaboration status and activity bar to the notebook interface.',
  autoStart: true,
  requires: [INotebookShell, INotebookTracker, ICollaborationService],
  optional: [ITranslator],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    tracker: INotebookTracker,
    collaborationService: ICollaborationService,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    
    // Create the collaboration bar component
    const collaborationBar = new CollaborationBar({
      collaborationService,
      translator: translator ?? nullTranslator
    });
    
    // Add the collaboration bar to the shell
    shell.add(collaborationBar, 'CollabBar', { rank: 1000 });
    
    // Add command to toggle the collaboration bar
    app.commands.addCommand(CommandIDs.toggleCollaborationBar, {
      label: trans.__('Toggle Collaboration Bar'),
      execute: () => {
        const isVisible = collaborationBar.isVisible;
        collaborationBar.setHidden(isVisible);
        return isVisible ? 'hide' : 'show';
      },
      isToggled: () => collaborationBar.isVisible
    });
    
    // Update the collaboration bar when the current notebook changes
    tracker.currentChanged.connect(() => {
      const current = tracker.currentWidget;
      if (current) {
        collaborationBar.update();
      }
    });
  }
};

/**
 * A plugin to add user presence and awareness indicators to the notebook.
 */
const userPresencePlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:user-presence',
  description: 'A plugin that adds user presence and cursor position indicators to the notebook.',
  autoStart: true,
  requires: [INotebookTracker, IAwarenessService],
  optional: [IToolbarWidgetRegistry, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    awarenessService: IAwarenessService,
    toolbarRegistry: IToolbarWidgetRegistry | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    
    // Add user presence indicators to each notebook panel
    tracker.widgetAdded.connect((sender, panel) => {
      // Create user presence component for this notebook
      const userPresence = new UserPresence({
        notebookPanel: panel,
        awarenessService,
        translator: translator ?? nullTranslator
      });
      
      // Attach to the notebook panel
      panel.content.node.appendChild(userPresence.node);
      
      // Register cleanup on panel dispose
      panel.disposed.connect(() => {
        userPresence.dispose();
      });
    });
    
    // Add user list to toolbar if toolbar registry is available
    if (toolbarRegistry) {
      toolbarRegistry.addFactory('Notebook', 'userPresence', (toolbar) => {
        const widget = new Widget();
        widget.addClass('jp-UserPresenceToolbar');
        widget.node.textContent = trans.__('Collaborators');
        return widget;
      });
    }
  }
};

/**
 * A plugin to add cell-level locking capabilities to the notebook.
 */
const cellLockPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:cell-lock',
  description: 'A plugin that adds cell-level locking capabilities to prevent concurrent editing conflicts.',
  autoStart: true,
  requires: [INotebookTracker, ILockService],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    lockService: ILockService,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    
    // Add lock indicators to each notebook panel
    tracker.widgetAdded.connect((sender, panel) => {
      // Create cell lock indicators for this notebook
      panel.content.widgets.forEach(cell => {
        const lockIndicator = new CellLockIndicator({
          cell,
          lockService,
          translator: translator ?? nullTranslator
        });
        
        cell.node.appendChild(lockIndicator.node);
      });
      
      // Handle new cells being added
      panel.model?.cells.changed.connect((sender, args) => {
        if (args.type === 'add') {
          args.newValues.forEach((model, index) => {
            const cell = panel.content.widgets[args.newIndex + index];
            const lockIndicator = new CellLockIndicator({
              cell,
              lockService,
              translator: translator ?? nullTranslator
            });
            
            cell.node.appendChild(lockIndicator.node);
          });
        }
      });
    });
    
    // Add command to toggle cell lock
    app.commands.addCommand(CommandIDs.toggleCellLock, {
      label: trans.__('Toggle Cell Lock'),
      execute: async () => {
        const current = tracker.currentWidget;
        if (!current) {
          return;
        }
        
        const activeCell = current.content.activeCell;
        if (!activeCell) {
          return;
        }
        
        const cellId = activeCell.model.id;
        const isLocked = await lockService.isLocked(cellId);
        
        if (isLocked) {
          await lockService.releaseLock(cellId);
          return 'unlocked';
        } else {
          await lockService.acquireLock(cellId);
          return 'locked';
        }
      },
      isEnabled: () => !!tracker.currentWidget?.content.activeCell
    });
    
    // Add to command palette if available
    if (palette) {
      palette.addItem({
        command: CommandIDs.toggleCellLock,
        category: 'Notebook Collaboration'
      });
    }
  }
};

/**
 * A plugin to add version history and diff viewing capabilities to the notebook.
 */
const historyViewerPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:history-viewer',
  description: 'A plugin that adds version history and diff viewing capabilities to the notebook.',
  autoStart: true,
  requires: [INotebookShell, INotebookTracker, IHistoryService],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    shell: INotebookShell,
    tracker: INotebookTracker,
    historyService: IHistoryService,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    
    // Create the history viewer component
    const historyViewer = new HistoryViewer({
      historyService,
      translator: translator ?? nullTranslator
    });
    
    // Add command to open history viewer
    app.commands.addCommand(CommandIDs.openHistoryViewer, {
      label: trans.__('Open Version History'),
      execute: () => {
        const current = tracker.currentWidget;
        if (!current) {
          return;
        }
        
        // Update history viewer with current notebook
        historyViewer.setNotebook(current);
        
        // Add to right sidebar if not already there
        if (!historyViewer.isAttached) {
          shell.add(historyViewer, 'right', { rank: 700 });
        }
        
        // Activate the widget
        shell.activateById(historyViewer.id);
      },
      isEnabled: () => !!tracker.currentWidget
    });
    
    // Add to command palette if available
    if (palette) {
      palette.addItem({
        command: CommandIDs.openHistoryViewer,
        category: 'Notebook Collaboration'
      });
    }
  }
};

/**
 * A plugin to add permissions management to the notebook.
 */
const permissionsPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:permissions',
  description: 'A plugin that adds permissions management capabilities to the notebook.',
  autoStart: true,
  requires: [INotebookTracker, IPermissionsService],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    permissionsService: IPermissionsService,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    
    // Create the permissions dialog component
    const permissionsDialog = new PermissionsDialog({
      permissionsService,
      translator: translator ?? nullTranslator
    });
    
    // Add command to open permissions dialog
    app.commands.addCommand(CommandIDs.openPermissionsDialog, {
      label: trans.__('Manage Notebook Permissions'),
      execute: () => {
        const current = tracker.currentWidget;
        if (!current) {
          return;
        }
        
        // Update permissions dialog with current notebook
        permissionsDialog.setNotebook(current);
        
        // Show the dialog
        permissionsDialog.show();
      },
      isEnabled: () => !!tracker.currentWidget
    });
    
    // Add to command palette if available
    if (palette) {
      palette.addItem({
        command: CommandIDs.openPermissionsDialog,
        category: 'Notebook Collaboration'
      });
    }
  }
};

/**
 * A plugin to add commenting and review capabilities to the notebook.
 */
const commentSystemPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyter-notebook/notebook-extension:comment-system',
  description: 'A plugin that adds commenting and review capabilities to the notebook.',
  autoStart: true,
  requires: [INotebookTracker, ICommentService],
  optional: [ICommandPalette, ITranslator],
  activate: (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    commentService: ICommentService,
    palette: ICommandPalette | null,
    translator: ITranslator | null
  ) => {
    const trans = (translator ?? nullTranslator).load('notebook');
    
    // Add comment system to each notebook panel
    tracker.widgetAdded.connect((sender, panel) => {
      // Create comment system for this notebook
      const commentSystem = new CommentSystem({
        notebookPanel: panel,
        commentService,
        translator: translator ?? nullTranslator
      });
      
      // Attach to the notebook panel
      panel.node.appendChild(commentSystem.node);
      
      // Register cleanup on panel dispose
      panel.disposed.connect(() => {
        commentSystem.dispose();
      });
    });
    
    // Add command to add a comment to the selected cell
    app.commands.addCommand(CommandIDs.addCellComment, {
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
        
        // Open comment creation interface for the active cell
        commentService.createComment(activeCell.model.id);
      },
      isEnabled: () => !!tracker.currentWidget?.content.activeCell
    });
    
    // Add to command palette if available
    if (palette) {
      palette.addItem({
        command: CommandIDs.addCellComment,
        category: 'Notebook Collaboration'
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
  // Collaboration plugins
  collaborationBarPlugin,
  userPresencePlugin,
  cellLockPlugin,
  historyViewerPlugin,
  permissionsPlugin,
  commentSystemPlugin
];

export default plugins;

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
   * A command to open the permissions dialog
   */
  export const openPermissionsDialog = 'notebook:open-permissions-dialog';

  /**
   * A command to open the history viewer
   */
  export const openHistoryViewer = 'notebook:open-history-viewer';

  /**
   * A command to toggle cell locking
   */
  export const toggleCellLock = 'notebook:toggle-cell-lock';

  /**
   * A command to add a comment to the selected cell
   */
  export const addCellComment = 'notebook:add-cell-comment';
}