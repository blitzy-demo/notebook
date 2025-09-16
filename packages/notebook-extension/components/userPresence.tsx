/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * UserPresence React component for rendering collaborative presence indicators
 * in Jupyter Notebook real-time collaborative editing environment. Displays user
 * avatars, cursor positions, and selection highlights with real-time updates
 * via Yjs awareness integration.
 */

import React, { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { ICellModel, CodeCell, MarkdownCell } from '@jupyterlab/cells';
import { Decoration, WidgetType, ViewPlugin, DecorationSet } from '@jupyterlab/codemirror';

import { CollaborationAwareness } from '../../notebook/src/collab/awareness';
import { ICollaborationAwareness } from '../../application/src/tokens';
import { ICollaborativeUser, UserColor } from '../../notebook/src/tokens';

/**
 * Props interface for UserPresence component
 */
export interface IUserPresenceProps {
  /**
   * CollaborationAwareness instance for tracking user presence
   */
  awareness: CollaborationAwareness;

  /**
   * Cell model for which to display presence indicators
   */
  cell?: ICellModel;

  /**
   * Cell widget for cursor/selection rendering
   */
  cellWidget?: CodeCell | MarkdownCell;

  /**
   * Enable smooth animations for cursor movements
   */
  enableAnimations?: boolean;

  /**
   * Custom presence timeout in milliseconds
   */
  presenceTimeout?: number;

  /**
   * Maximum number of avatars to display
   */
  maxAvatars?: number;

  /**
   * Show user names in avatar tooltips
   */
  showUsernames?: boolean;

  /**
   * Callback when user avatar is clicked
   */
  onUserClick?: (user: ICollaborativeUser) => void;

  /**
   * Custom CSS classes for styling
   */
  className?: string;
}

/**
 * User cursor decoration widget for CodeMirror integration
 */
class UserCursorWidget extends WidgetType {
  private user: ICollaborativeUser;
  private offset: number;

  constructor(user: ICollaborativeUser, offset: number) {
    super();
    this.user = user;
    this.offset = offset;
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'jp-UserPresence-cursor';
    element.style.borderColor = this.user.color;
    element.style.backgroundColor = this.user.color;
    element.setAttribute('data-user-id', this.user.userId);
    element.setAttribute('data-offset', this.offset.toString());
    element.title = `${this.user.displayName} (${this.user.username})`;
    return element;
  }

  eq(other: UserCursorWidget): boolean {
    return this.user.userId === other.user.userId &&
           this.offset === other.offset &&
           this.user.color === other.user.color;
  }

  get estimatedHeight(): number {
    return 20;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * User selection decoration widget for highlighting text ranges
 */
class UserSelectionWidget extends WidgetType {
  private user: ICollaborativeUser;
  private startOffset: number;
  private endOffset: number;

  constructor(user: ICollaborativeUser, startOffset: number, endOffset: number) {
    super();
    this.user = user;
    this.startOffset = startOffset;
    this.endOffset = endOffset;
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = 'jp-UserPresence-selection';
    element.style.backgroundColor = `${this.user.color}33`; // 20% opacity
    element.style.borderColor = this.user.color;
    element.setAttribute('data-user-id', this.user.userId);
    element.setAttribute('data-start', this.startOffset.toString());
    element.setAttribute('data-end', this.endOffset.toString());
    return element;
  }

  eq(other: UserSelectionWidget): boolean {
    return this.user.userId === other.user.userId &&
           this.startOffset === other.startOffset &&
           this.endOffset === other.endOffset &&
           this.user.color === other.user.color;
  }
}

/**
 * Generate a consistent color for a user based on their ID
 */
export function getUserColor(userId: string): UserColor {
  // Generate hash from user ID for consistent color assignment
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    const char = userId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Map to available colors
  const colors = Object.values(UserColor);
  const colorIndex = Math.abs(hash) % colors.length;
  return colors[colorIndex];
}

/**
 * UserPresence React component for displaying collaborative presence indicators
 */
const UserPresence: React.FC<IUserPresenceProps> = memo(({
  awareness,
  cell,
  cellWidget,
  enableAnimations = true,
  presenceTimeout,
  maxAvatars = 5,
  showUsernames = true,
  onUserClick,
  className = ''
}) => {
  // State for tracking remote users and their positions
  const [remoteUsers, setRemoteUsers] = useState<ICollaborativeUser[]>([]);
  const [cursorPositions, setCursorPositions] = useState<Map<string, { cellId: string; offset: number }>>(new Map());
  const [selectedCells, setSelectedCells] = useState<Map<string, string[]>>(new Map());
  const [decorations, setDecorations] = useState<DecorationSet>(Decoration.none);

  // Configure presence timeout if provided
  useEffect(() => {
    if (presenceTimeout && awareness) {
      awareness.setPresenceTimeout(presenceTimeout);
    }
  }, [awareness, presenceTimeout]);

  // Handle awareness updates for user join/leave events
  const handleUserJoin = useCallback((user: ICollaborativeUser) => {
    setRemoteUsers(prev => {
      const existing = prev.find(u => u.userId === user.userId);
      if (existing) {
        // Update existing user
        return prev.map(u => u.userId === user.userId ? user : u);
      } else {
        // Add new user
        return [...prev, user];
      }
    });

    // Get user's cursor position and selected cells
    if (awareness) {
      const cursorPos = awareness.getCursorPosition(user.userId);
      const selectedCellIds = awareness.getSelectedCells(user.userId);

      if (cursorPos) {
        setCursorPositions(prev => new Map(prev.set(user.userId, cursorPos)));
      }

      if (selectedCellIds && selectedCellIds.length > 0) {
        setSelectedCells(prev => new Map(prev.set(user.userId, selectedCellIds)));
      }
    }
  }, [awareness]);

  const handleUserLeave = useCallback((user: ICollaborativeUser) => {
    setRemoteUsers(prev => prev.filter(u => u.userId !== user.userId));
    setCursorPositions(prev => {
      const newMap = new Map(prev);
      newMap.delete(user.userId);
      return newMap;
    });
    setSelectedCells(prev => {
      const newMap = new Map(prev);
      newMap.delete(user.userId);
      return newMap;
    });
  }, []);

  // Update decorations when users or positions change
  const updateDecorations = useCallback(() => {
    if (!cellWidget || !cell) {
      setDecorations(Decoration.none);
      return;
    }

    const decorationSet: any[] = [];

    // Create cursor decorations for users in this cell
    cursorPositions.forEach((position, userId) => {
      if (position.cellId === cell.id) {
        const user = remoteUsers.find(u => u.userId === userId);
        if (user && user.isActive) {
          const cursorDecoration = Decoration.widget({
            widget: new UserCursorWidget(user, position.offset),
            side: 1
          });
          decorationSet.push(cursorDecoration.range(position.offset));
        }
      }
    });

    // Create selection decorations for users with selections in this cell
    selectedCells.forEach((cellIds, userId) => {
      if (cellIds.includes(cell.id)) {
        const user = remoteUsers.find(u => u.userId === userId);
        if (user && user.isActive) {
          // For simplicity, highlight entire cell content for selections
          // In a real implementation, this would be more sophisticated
          const cellText = cell.sharedModel.getSource();
          if (cellText.length > 0) {
            const selectionDecoration = Decoration.mark({
              class: 'jp-UserPresence-selection',
              style: `background-color: ${user.color}20; border-left: 2px solid ${user.color};`
            });
            decorationSet.push(selectionDecoration.range(0, cellText.length));
          }
        }
      }
    });

    setDecorations(Decoration.set(decorationSet));
  }, [cellWidget, cell, remoteUsers, cursorPositions, selectedCells]);

  // Set up awareness event listeners
  useEffect(() => {
    if (!awareness) {
      return;
    }

    // Connect to user join/leave signals
    awareness.onUserJoin.connect(handleUserJoin);
    awareness.onUserLeave.connect(handleUserLeave);

    // Initialize with current active users
    const currentUsers = awareness.activeUsers;
    setRemoteUsers(currentUsers);

    // Get current positions for all users
    currentUsers.forEach(user => {
      const cursorPos = awareness.getCursorPosition(user.userId);
      const selectedCellIds = awareness.getSelectedCells(user.userId);

      if (cursorPos) {
        setCursorPositions(prev => new Map(prev.set(user.userId, cursorPos)));
      }

      if (selectedCellIds && selectedCellIds.length > 0) {
        setSelectedCells(prev => new Map(prev.set(user.userId, selectedCellIds)));
      }
    });

    return () => {
      awareness.onUserJoin.disconnect(handleUserJoin);
      awareness.onUserLeave.disconnect(handleUserLeave);
    };
  }, [awareness, handleUserJoin, handleUserLeave]);

  // Update decorations when dependencies change
  useEffect(() => {
    updateDecorations();
  }, [updateDecorations]);

  // Handle user avatar clicks
  const handleAvatarClick = useCallback((user: ICollaborativeUser) => {
    if (onUserClick) {
      onUserClick(user);
    } else {
      // Default behavior: focus on user's cursor position
      const position = awareness?.getCursorPosition(user.userId);
      if (position && cellWidget) {
        // Implementation would scroll to user's position
        console.log(`Focus on user ${user.displayName} at position:`, position);
      }
    }
  }, [awareness, cellWidget, onUserClick]);

  // Memoize displayed users (limit to maxAvatars)
  const displayedUsers = useMemo(() => {
    const activeUsers = remoteUsers.filter(user => user.isActive);
    return activeUsers.slice(0, maxAvatars);
  }, [remoteUsers, maxAvatars]);

  // Render user avatars
  const renderUserAvatars = () => {
    if (displayedUsers.length === 0) {
      return null;
    }

    return (
      <div className="jp-UserPresence-avatars">
        {displayedUsers.map((user, index) => (
          <div
            key={user.userId}
            className={`jp-UserPresence-avatar ${enableAnimations ? 'jp-UserPresence-avatar-animated' : ''}`}
            style={{
              borderColor: user.color,
              backgroundColor: user.color,
              zIndex: displayedUsers.length - index
            }}
            title={showUsernames ? `${user.displayName} (${user.username})` : user.displayName}
            onClick={() => handleAvatarClick(user)}
          >
            {user.avatar ? (
              <img
                src={user.avatar}
                alt={user.displayName}
                className="jp-UserPresence-avatar-image"
              />
            ) : (
              <span className="jp-UserPresence-avatar-initials">
                {user.displayName.charAt(0).toUpperCase()}
              </span>
            )}

            {/* Activity indicator */}
            <div
              className={`jp-UserPresence-activity-indicator ${user.isActive ? 'active' : 'idle'}`}
              style={{ backgroundColor: user.isActive ? '#4caf50' : '#ff9800' }}
            />
          </div>
        ))}

        {/* Show count if more users than displayed */}
        {remoteUsers.filter(u => u.isActive).length > maxAvatars && (
          <div className="jp-UserPresence-avatar jp-UserPresence-avatar-count">
            +{remoteUsers.filter(u => u.isActive).length - maxAvatars}
          </div>
        )}
      </div>
    );
  };

  // Don't render if no awareness or no active users
  if (!awareness || displayedUsers.length === 0) {
    return null;
  }

  return (
    <div className={`jp-UserPresence ${className}`}>
      {renderUserAvatars()}

      {/* Connection status indicator */}
      <div className="jp-UserPresence-status">
        <div
          className={`jp-UserPresence-connection-indicator ${awareness.isEnabled ? 'connected' : 'disconnected'}`}
          title={awareness.isEnabled ? 'Connected to collaboration server' : 'Disconnected from collaboration server'}
        />
      </div>
    </div>
  );
});

UserPresence.displayName = 'UserPresence';

/**
 * Namespace for UserPresenceComponent static methods following JupyterLab patterns
 */
export namespace UserPresenceComponent {
  /**
   * Create a new UserPresence widget wrapped in ReactWidget
   *
   * @param awareness - The CollaborationAwareness instance
   * @param options - Additional component options
   * @returns ReactWidget containing UserPresence component
   */
  export const create = (
    awareness: CollaborationAwareness,
    options: Partial<IUserPresenceProps> = {}
  ): ReactWidget => {
    return ReactWidget.create(
      <UserPresence awareness={awareness} {...options} />
    );
  };
}

export default UserPresence;
