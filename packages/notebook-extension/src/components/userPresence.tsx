// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { Notebook, NotebookPanel } from '@jupyterlab/notebook';
import { IAwarenessService } from '../../tokens';

/**
 * Interface for user awareness state
 */
interface IUserState {
  id: number;
  name: string;
  color: string;
  avatar?: string;
  cursor?: {
    cellId: string;
    position: number;
  };
  selection?: {
    cellId: string;
    start: number;
    end: number;
  };
  activeCell?: string;
  status?: 'active' | 'idle' | 'away';
  lastActive?: number;
}

/**
 * Props for the UserPresence component
 */
interface IUserPresenceProps {
  /**
   * The notebook panel containing the notebook
   */
  notebookPanel: NotebookPanel;

  /**
   * The awareness service for tracking user presence
   */
  awarenessService: IAwarenessService;

  /**
   * The translator for internationalization
   */
  translator?: ITranslator;
}

/**
 * A React component for displaying user presence in a collaborative notebook
 */
const UserPresence = ({
  notebookPanel,
  awarenessService,
  translator = nullTranslator
}: IUserPresenceProps): JSX.Element => {
  const trans = translator.load('notebook');
  const [users, setUsers] = useState<IUserState[]>([]);
  const [currentUserId, setCurrentUserId] = useState<number>(0);

  // Get the current user's ID from the awareness service
  useEffect(() => {
    if (awarenessService) {
      setCurrentUserId(awarenessService.getLocalClientId());
    }
  }, [awarenessService]);

  // Update the users state when awareness changes
  const handleAwarenessUpdate = useCallback(() => {
    if (!awarenessService) {
      return;
    }

    const states = awarenessService.getStates();
    const userStates: IUserState[] = [];

    // Convert the awareness states to our user state format
    states.forEach((state, clientId) => {
      if (state && state.user) {
        userStates.push({
          id: clientId,
          name: state.user.name || trans.__('Anonymous'),
          color: state.user.color || '#1976d2',
          avatar: state.user.avatar,
          cursor: state.cursor,
          selection: state.selection,
          activeCell: state.activeCell,
          status: state.status || 'active',
          lastActive: state.lastActive || Date.now()
        });
      }
    });

    setUsers(userStates);
  }, [awarenessService, trans]);

  // Subscribe to awareness updates
  useEffect(() => {
    if (!awarenessService) {
      return;
    }

    // Initial update
    handleAwarenessUpdate();

    // Subscribe to awareness changes
    awarenessService.on('change', handleAwarenessUpdate);

    return () => {
      awarenessService.off('change', handleAwarenessUpdate);
    };
  }, [awarenessService, handleAwarenessUpdate]);

  // Filter out the current user from the displayed list
  const otherUsers = useMemo(() => {
    return users.filter(user => user.id !== currentUserId);
  }, [users, currentUserId]);

  // Handle clicking on a user avatar to focus on their position
  const handleUserClick = useCallback(
    (user: IUserState) => {
      if (!notebookPanel || !user.activeCell) {
        return;
      }

      // Find the cell by ID and scroll to it
      const notebook = notebookPanel.content;
      const cells = notebook.widgets;
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        if (cell.model.id === user.activeCell) {
          notebook.activeCellIndex = i;
          notebook.scrollToCell(cell);
          break;
        }
      }
    },
    [notebookPanel]
  );

  // Generate initials for avatar fallback
  const getInitials = (name: string): string => {
    return name
      .split(' ')
      .map(part => part.charAt(0))
      .join('')
      .toUpperCase()
      .substring(0, 2);
  };

  // Format the time since last activity
  const formatTimeSince = (timestamp: number): string => {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) {
      return trans.__('just now');
    } else if (seconds < 3600) {
      const minutes = Math.floor(seconds / 60);
      return trans.__('%1 minutes ago', minutes);
    } else if (seconds < 86400) {
      const hours = Math.floor(seconds / 3600);
      return trans.__('%1 hours ago', hours);
    } else {
      const days = Math.floor(seconds / 86400);
      return trans.__('%1 days ago', days);
    }
  };

  // Render the status text based on user status
  const getStatusText = (user: IUserState): string => {
    switch (user.status) {
      case 'active':
        return user.cursor
          ? trans.__('typing')
          : trans.__('viewing');
      case 'idle':
        return trans.__('idle');
      case 'away':
        return trans.__('away');
      default:
        return trans.__('online');
    }
  };

  return (
    <div className="jp-UserPresence">
      {otherUsers.length > 0 ? (
        <div className="jp-UserPresence-container">
          {otherUsers.map(user => (
            <div
              key={user.id}
              className={`jp-UserPresence-user jp-UserPresence-status-${user.status}`}
              onClick={() => handleUserClick(user)}
              style={{ borderColor: user.color }}
              title={trans.__('%1 (%2) - %3', user.name, getStatusText(user), formatTimeSince(user.lastActive || Date.now()))}
            >
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={user.name}
                  className="jp-UserPresence-avatar"
                />
              ) : (
                <div
                  className="jp-UserPresence-initials"
                  style={{ backgroundColor: user.color }}
                >
                  {getInitials(user.name)}
                </div>
              )}
              <div className="jp-UserPresence-tooltip">
                <div className="jp-UserPresence-tooltipName">{user.name}</div>
                <div className="jp-UserPresence-tooltipStatus">
                  {getStatusText(user)}
                </div>
                <div className="jp-UserPresence-tooltipTime">
                  {formatTimeSince(user.lastActive || Date.now())}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="jp-UserPresence-empty">
          {trans.__('No other users currently online')}
        </div>
      )}
    </div>
  );
};

/**
 * A namespace for UserPresenceComponent statics.
 */
export namespace UserPresenceComponent {
  /**
   * Create a new UserPresenceComponent.
   *
   * @param notebookPanel - The notebook panel
   * @param awarenessService - The awareness service
   * @param translator - The translator
   */
  export const create = ({
    notebookPanel,
    awarenessService,
    translator
  }: {
    notebookPanel: NotebookPanel;
    awarenessService: IAwarenessService;
    translator?: ITranslator;
  }): ReactWidget => {
    return ReactWidget.create(
      <UserPresence
        notebookPanel={notebookPanel}
        awarenessService={awarenessService}
        translator={translator}
      />
    );
  };
}

/**
 * A class for rendering user cursor positions in the notebook.
 */
export class UserCursorManager {
  /**
   * Create a new UserCursorManager.
   *
   * @param notebook - The notebook
   * @param awarenessService - The awareness service
   */
  constructor(
    private notebook: Notebook,
    private awarenessService: IAwarenessService
  ) {
    this._initialize();
  }

  /**
   * Initialize the cursor manager.
   */
  private _initialize(): void {
    // Subscribe to awareness changes
    this.awarenessService.on('change', this._handleAwarenessUpdate);

    // Clean up when the notebook is disposed
    this.notebook.disposed.connect(this.dispose);
  }

  /**
   * Handle awareness updates.
   */
  private _handleAwarenessUpdate = (): void => {
    // Clear existing cursor elements
    this._clearCursors();

    // Get the current user's ID
    const currentUserId = this.awarenessService.getLocalClientId();

    // Get all user states
    const states = this.awarenessService.getStates();

    // Render cursors for each user (except the current user)
    states.forEach((state, clientId) => {
      if (clientId !== currentUserId && state && state.cursor) {
        this._renderCursor(clientId, state);
      }
    });
  };

  /**
   * Render a cursor for a user.
   *
   * @param clientId - The client ID
   * @param state - The user's state
   */
  private _renderCursor(clientId: number, state: any): void {
    if (!state.cursor || !state.cursor.cellId) {
      return;
    }

    // Find the cell by ID
    const cells = this.notebook.widgets;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (cell.model.id === state.cursor.cellId) {
        // Create cursor element
        const cursorElement = document.createElement('div');
        cursorElement.className = 'jp-UserCursor';
        cursorElement.dataset.clientId = String(clientId);
        cursorElement.style.backgroundColor = state.user?.color || '#1976d2';

        // Add user name tooltip
        const tooltip = document.createElement('div');
        tooltip.className = 'jp-UserCursor-tooltip';
        tooltip.textContent = state.user?.name || 'Anonymous';
        tooltip.style.backgroundColor = state.user?.color || '#1976d2';
        cursorElement.appendChild(tooltip);

        // Position the cursor in the cell
        // This is a simplified approach - actual implementation would need to
        // work with the specific editor used in the cell
        const editor = cell.editor;
        if (editor) {
          // Add the cursor to the editor's node
          editor.node.appendChild(cursorElement);

          // Position would need to be calculated based on the editor's layout
          // This is a placeholder for the actual positioning logic
          cursorElement.style.left = '0px';
          cursorElement.style.top = '0px';
        }

        // If there's a selection, render it
        if (state.selection && state.selection.cellId === state.cursor.cellId) {
          this._renderSelection(cell, state.selection, state.user?.color || '#1976d2');
        }

        break;
      }
    }
  }

  /**
   * Render a selection for a user.
   *
   * @param cell - The cell
   * @param selection - The selection
   * @param color - The user's color
   */
  private _renderSelection(cell: any, selection: any, color: string): void {
    // This is a placeholder for the actual selection rendering logic
    // Actual implementation would need to work with the specific editor used in the cell
    // and create appropriate DOM elements to highlight the selection
  }

  /**
   * Clear all cursor elements.
   */
  private _clearCursors(): void {
    // Remove all cursor elements
    document.querySelectorAll('.jp-UserCursor').forEach(el => el.remove());

    // Remove all selection highlights
    document.querySelectorAll('.jp-UserSelection').forEach(el => el.remove());
  }

  /**
   * Dispose of the cursor manager.
   */
  dispose(): void {
    this.awarenessService.off('change', this._handleAwarenessUpdate);
    this._clearCursors();
  }
}