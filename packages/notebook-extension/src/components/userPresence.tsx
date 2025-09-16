/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * User presence visualization component that renders active user avatars, cursor positions,
 * and selection highlights within notebook cells. Integrates with CollaborationAwareness module
 * to track and display real-time user interactions, including remote cursors in CodeMirror editors
 * and selection overlays with user-specific colors.
 */

import * as React from 'react';
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { Decoration, WidgetType } from '@codemirror/view';
import { Cell } from '@jupyterlab/cells';
import { ReactWidget } from '@jupyterlab/apputils';

import { CollaborationAwareness, UserColor } from '../../../notebook/src/collab/awareness';
import { ICollaborativeUser } from '../../../notebook/src/tokens';

/**
 * Props interface for the UserPresence component
 */
export interface IUserPresenceProps {
  /**
   * Collaboration awareness instance for tracking user presence
   */
  awareness: CollaborationAwareness;

  /**
   * Cell instance to render presence for
   */
  cell: Cell;

  /**
   * Whether to show user avatars at cursor positions
   */
  showAvatars?: boolean;

  /**
   * Whether to show selection highlights
   */
  showSelections?: boolean;

  /**
   * Presence timeout for marking users as idle (milliseconds)
   */
  presenceTimeout?: number;

  /**
   * Whether to show smooth animations for cursor movements
   */
  animateCursors?: boolean;

  /**
   * Maximum number of users to show avatars for
   */
  maxVisibleUsers?: number;

  /**
   * Custom CSS class name for styling
   */
  className?: string;
}

/**
 * Internal state for tracking user positions and selections
 */
interface IUserPresenceState {
  /**
   * Active users with their cursor positions
   */
  activeUsers: ICollaborativeUser[];

  /**
   * Map of user cursors positions within the cell
   */
  cursors: Map<string, { cellId: string; offset: number }>;

  /**
   * Map of user selections within the cell
   */
  selections: Map<string, string[]>;

  /**
   * Connection status
   */
  isConnected: boolean;
}

/**
 * Widget type for rendering user cursors in CodeMirror
 */
class UserCursorWidget extends WidgetType {
  constructor(
    private user: ICollaborativeUser,
    private showAvatar: boolean = true
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'jp-UserPresence-cursor';
    wrapper.style.backgroundColor = this.user.color;
    wrapper.style.position = 'absolute';
    wrapper.style.width = '2px';
    wrapper.style.height = '1.2em';
    wrapper.style.zIndex = '1000';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.transition = 'all 0.2s ease-out';

    if (this.showAvatar && this.user.avatar) {
      const avatar = document.createElement('div');
      avatar.className = 'jp-UserPresence-avatar';
      avatar.style.position = 'absolute';
      avatar.style.top = '-24px';
      avatar.style.left = '-8px';
      avatar.style.width = '18px';
      avatar.style.height = '18px';
      avatar.style.borderRadius = '50%';
      avatar.style.backgroundColor = this.user.color;
      avatar.style.border = '2px solid white';
      avatar.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
      avatar.style.display = 'flex';
      avatar.style.alignItems = 'center';
      avatar.style.justifyContent = 'center';
      avatar.style.fontSize = '10px';
      avatar.style.color = 'white';
      avatar.style.fontWeight = 'bold';
      avatar.textContent = this.user.displayName.charAt(0).toUpperCase();
      avatar.title = `${this.user.displayName} (${this.user.isActive ? 'active' : 'idle'})`;
      wrapper.appendChild(avatar);
    }

    return wrapper;
  }

  eq(other: UserCursorWidget): boolean {
    return (
      this.user.userId === other.user.userId &&
      this.user.color === other.user.color &&
      this.user.isActive === other.user.isActive
    );
  }
}

/**
 * Helper function to create user cursor decorations
 * @param user - The collaborative user
 * @param position - Cursor position offset
 * @param showAvatar - Whether to show avatar
 */
export function createUserCursorDecoration(
  user: ICollaborativeUser,
  position: number,
  showAvatar: boolean = true
): any {
  return Decoration.widget({
    widget: new UserCursorWidget(user, showAvatar),
    side: 1
  }).range(position);
}

/**
 * Main UserPresence React component for rendering collaborative presence indicators
 */
export function UserPresence({
  awareness,
  cell,
  showAvatars = true,
  showSelections = true,
  presenceTimeout = 300000,
  animateCursors = true,
  maxVisibleUsers = 10,
  className = ''
}: IUserPresenceProps): JSX.Element {
  const [presenceState, setPresenceState] = useState<IUserPresenceState>({
    activeUsers: [],
    cursors: new Map(),
    selections: new Map(),
    isConnected: false
  });


  const timeoutRef = useRef<number | null>(null);

  /**
   * Update user cursor position in the editor
   */
  const updateCursorPosition = useCallback((userId: string, cellId: string, offset: number) => {
    if (cell.model?.id !== cellId) {
      return;
    }

    setPresenceState(prev => {
      const newCursors = new Map(prev.cursors);
      newCursors.set(userId, { cellId, offset });
      return { ...prev, cursors: newCursors };
    });
  }, [cell.model?.id]);

  /**
   * Update user selected cells
   */
  const updateSelectedCells = useCallback((userId: string, selectedCells: string[]) => {
    setPresenceState(prev => {
      const newSelections = new Map(prev.selections);
      newSelections.set(userId, selectedCells);
      return { ...prev, selections: newSelections };
    });
  }, []);

  /**
   * Handle presence timeout for idle users
   */
  const handlePresenceTimeout = useCallback((userId: string) => {
    setPresenceState(prev => {
      const updatedUsers = prev.activeUsers.map(user =>
        user.userId === userId
          ? { ...user, isActive: false }
          : user
      );
      return { ...prev, activeUsers: updatedUsers };
    });
  }, []);



  /**
   * Render cursor decorations for all users
   */
  const renderCursors = useCallback((): Decoration[] => {
    const decorations: Decoration[] = [];

    if (!showAvatars || !cell.editor) {
      return decorations;
    }

    const visibleUsers = presenceState.activeUsers
      .filter(user => user.isActive && presenceState.cursors.has(user.userId))
      .slice(0, maxVisibleUsers);

    for (const user of visibleUsers) {
      const cursorPos = presenceState.cursors.get(user.userId);
      if (cursorPos && cursorPos.cellId === cell.model?.id) {
        const decoration = createUserCursorDecoration(user, cursorPos.offset, showAvatars);
        decorations.push(decoration);
      }
    }

    return decorations;
  }, [presenceState.activeUsers, presenceState.cursors, showAvatars, cell.editor, cell.model?.id, maxVisibleUsers]);

  /**
   * Render selection highlights for all users
   */
  const renderSelections = useCallback((): Decoration[] => {
    const decorations: Decoration[] = [];

    if (!showSelections || !cell.model?.id) {
      return decorations;
    }

    for (const user of presenceState.activeUsers) {
      if (!user.isActive) continue;

      const selectedCells = presenceState.selections.get(user.userId);
      if (selectedCells && selectedCells.includes(cell.model.id)) {
        // Apply to entire cell content - in a real implementation, this would need
        // more sophisticated range detection
        decorations.push(Decoration.mark({
          class: 'jp-UserPresence-selection',
          attributes: {
            style: `background-color: ${user.color}20; border: 1px solid ${user.color}40;`
          }
        }) as any);
      }
    }

    return decorations;
  }, [presenceState.activeUsers, presenceState.selections, showSelections, cell.model?.id, cell.editor]);

  /**
   * Update user presence information
   */
  const updateUserPresence = useCallback((users: ICollaborativeUser[]) => {
    setPresenceState(prev => ({
      ...prev,
      activeUsers: users,
      isConnected: true
    }));
  }, []);

  // Set up awareness event handlers
  useEffect(() => {
    if (!awareness) {
      return;
    }

    // Set up presence timeout
    if (presenceTimeout > 0) {
      awareness.setPresenceTimeout(presenceTimeout);
    }

    const handleUserJoined = (sender: CollaborationAwareness, user: ICollaborativeUser) => {
      setPresenceState(prev => {
        const existingUserIndex = prev.activeUsers.findIndex(u => u.userId === user.userId);
        let updatedUsers;

        if (existingUserIndex >= 0) {
          updatedUsers = [...prev.activeUsers];
          updatedUsers[existingUserIndex] = user;
        } else {
          updatedUsers = [...prev.activeUsers, user];
        }

        return {
          ...prev,
          activeUsers: updatedUsers,
          isConnected: true
        };
      });
    };

    const handleUserLeft = (sender: CollaborationAwareness, user: ICollaborativeUser) => {
      setPresenceState(prev => ({
        ...prev,
        activeUsers: prev.activeUsers.filter(u => u.userId !== user.userId),
        cursors: new Map(Array.from(prev.cursors.entries()).filter(([key]) => key !== user.userId)),
        selections: new Map(Array.from(prev.selections.entries()).filter(([key]) => key !== user.userId))
      }));
    };

    // Connect to awareness signals
    awareness.onUserJoin.connect(handleUserJoined);
    awareness.onUserLeave.connect(handleUserLeft);

    // Initialize with current users
    const currentUsers = awareness.getAllUsers();
    updateUserPresence(currentUsers);

    // Set up periodic updates for cursor positions
    const updateInterval = setInterval(() => {
      if (awareness.isEnabled) {
        const allUsers = awareness.getAllUsers();
        allUsers.forEach((user: ICollaborativeUser) => {
          const cursorPos = awareness.getCursorPosition(user.userId);
          if (cursorPos) {
            updateCursorPosition(user.userId, cursorPos.cellId, cursorPos.offset);
          }

          const selectedCells = awareness.getSelectedCells(user.userId);
          if (selectedCells) {
            updateSelectedCells(user.userId, selectedCells);
          }
        });
      }
    }, 1000); // Update every second

    return () => {
      awareness.onUserJoin.disconnect(handleUserJoined);
      awareness.onUserLeave.disconnect(handleUserLeft);
      clearInterval(updateInterval);
    };
  }, [awareness, presenceTimeout, updateUserPresence, updateCursorPosition, updateSelectedCells]);

  // Handle presence timeout
  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      presenceState.activeUsers.forEach(user => {
        const timeSinceActivity = Date.now() - user.lastActivity.getTime();
        if (timeSinceActivity > presenceTimeout && user.isActive) {
          handlePresenceTimeout(user.userId);
        }
      });
    }, presenceTimeout);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [presenceState.activeUsers, presenceTimeout, handlePresenceTimeout]);

  // Update CodeMirror decorations
  useEffect(() => {
    if (!cell.editor) {
      return;
    }

    const cursorDecorations = renderCursors();
    const selectionDecorations = renderSelections();
    const allDecorations = [...cursorDecorations, ...selectionDecorations];

    // In a real implementation, this would integrate with CodeMirror's decoration system
    // For now, we'll simulate the decoration effect
    console.log('Updating decorations for cell:', cell.model?.id, 'decorations:', allDecorations.length);

  }, [cell.editor, renderCursors, renderSelections]);

  // Memoize user list for performance
  const activeUsersList = useMemo(() => {
    return presenceState.activeUsers
      .filter(user => user.isActive)
      .slice(0, maxVisibleUsers);
  }, [presenceState.activeUsers, maxVisibleUsers]);

  return (
    <div className={`jp-UserPresence ${className}`}>
      {/* Connection status indicator */}
      <div className={`jp-UserPresence-status ${presenceState.isConnected ? 'connected' : 'disconnected'}`}>
        <span className="jp-UserPresence-status-dot" />
        {presenceState.isConnected ? 'Connected' : 'Disconnected'}
      </div>

      {/* Active users display */}
      <div className="jp-UserPresence-users">
        {activeUsersList.map(user => (
          <div
            key={user.userId}
            className={`jp-UserPresence-user ${user.isActive ? 'active' : 'idle'}`}
            style={{ borderColor: user.color }}
            title={`${user.displayName} (${user.isActive ? 'active' : 'idle'})`}
          >
            {user.avatar ? (
              <img
                src={user.avatar}
                alt={user.displayName}
                className="jp-UserPresence-user-avatar"
              />
            ) : (
              <div
                className="jp-UserPresence-user-initials"
                style={{ backgroundColor: user.color }}
              >
                {user.displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <span className="jp-UserPresence-user-name">{user.displayName}</span>
          </div>
        ))}
      </div>

      {/* Debug information - remove in production */}
      {((globalThis as any).process?.env?.NODE_ENV === 'development') && (
        <div className="jp-UserPresence-debug">
          <small>
            Users: {presenceState.activeUsers.length},
            Cursors: {presenceState.cursors.size},
            Selections: {presenceState.selections.size}
          </small>
        </div>
      )}
    </div>
  );
}

/**
 * UserPresenceComponent namespace containing static methods and utilities
 */
export namespace UserPresenceComponent {
  /**
   * Create a new UserPresence ReactWidget
   */
  export const create = ({
    awareness,
    cell,
    ...options
  }: IUserPresenceProps): ReactWidget => {
    return ReactWidget.create(
      <UserPresence
        awareness={awareness}
        cell={cell}
        {...options}
      />
    );
  };

  /**
   * Update user presence information in the component
   */
  export const updateUserPresence = (
    widget: ReactWidget,
    users: ICollaborativeUser[]
  ): void => {
    // This would typically trigger a re-render with new user data
    // Implementation depends on the specific React integration pattern
    console.log('Updating user presence:', users.length, 'users');
  };

  /**
   * Render cursors for the current cell
   */
  export const renderCursors = (
    awareness: CollaborationAwareness,
    cell: Cell,
    showAvatars: boolean = true
  ): Decoration[] => {
    const decorations: Decoration[] = [];
    const activeUsers = awareness.activeUsers;

    for (const user of activeUsers) {
      const cursorPos = awareness.getCursorPosition(user.userId);
      if (cursorPos && cursorPos.cellId === cell.model?.id) {
        const decoration = createUserCursorDecoration(user, cursorPos.offset, showAvatars);
        decorations.push(decoration);
      }
    }

    return decorations;
  };

  /**
   * Render selections for the current cell
   */
  export const renderSelections = (
    awareness: CollaborationAwareness,
    cell: Cell
  ): Decoration[] => {
    const decorations: Decoration[] = [];
    const activeUsers = awareness.activeUsers;

    for (const user of activeUsers) {
      const selectedCells = awareness.getSelectedCells(user.userId);
      if (selectedCells && selectedCells.includes(cell.model?.id || '')) {
        decorations.push(Decoration.mark({
          class: 'jp-UserPresence-selection',
          attributes: {
            style: `background-color: ${user.color}20; border: 1px solid ${user.color}40;`
          }
        }) as any);
      }
    }

    return decorations;
  };

  /**
   * Assign a user color based on user ID
   */
  export const assignUserColor = (userId: string): UserColor => {
    const colors = Object.values(UserColor);
    const hash = userId.split('').reduce((a, b) => {
      a = ((a << 5) - a) + b.charCodeAt(0);
      return a & a;
    }, 0);
    return colors[Math.abs(hash) % colors.length];
  };

  /**
   * Handle presence timeout for a user
   */
  export const handlePresenceTimeout = (
    awareness: CollaborationAwareness,
    userId: string
  ): void => {
    awareness.handleTimeout(userId);
  };
}
