/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

/**
 * CollaborationBar React component implementing comprehensive collaboration status display.
 * Shows active users, connection status, and collaboration controls with real-time updates
 * through Yjs awareness protocol integration. Provides user presence visualization with
 * avatars, status indicators, and quick access to collaboration features.
 */

import * as React from 'react';
const { useState, useEffect, useCallback } = React;
import { ReactWidget } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';

import { CollaborationAwareness } from '../../notebook/src/collab/awareness';
import { ICollaborationBar, ICollaborationAwareness } from '../../application/src/tokens';
import { ICollaborativeUser } from '../../notebook/src/tokens';

/**
 * Props interface for the CollaborationBar functional component
 */
interface ICollaborationBarProps {
  /**
   * Collaboration awareness service for user tracking
   */
  awareness: CollaborationAwareness;

  /**
   * Notebook tracker for monitoring active notebook sessions
   */
  notebookTracker: INotebookTracker;

  /**
   * Translation service for internationalization
   */
  translator: ITranslator;
}

/**
 * Internal user interface extending ICollaborativeUser with UI state
 */
interface IUIUser extends ICollaborativeUser {
  /**
   * Whether user avatar should show hover state
   */
  isHovered?: boolean;

  /**
   * Animation state for smooth transitions
   */
  animationState?: 'entering' | 'stable' | 'leaving';
}

/**
 * CollaborationBar functional React component with comprehensive presence display
 */
const CollaborationBarComponent = ({
  awareness,
  notebookTracker,
  translator
}: ICollaborationBarProps): JSX.Element => {
  const trans = translator.load('notebook');

  // Component state management
  const [activeUsers, setActiveUsers] = useState<IUIUser[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<boolean>(false);
  const [collaborationEnabled, setCollaborationEnabled] = useState<boolean>(true);
  const [hoveredUserId, setHoveredUserId] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState<boolean>(false);

  /**
   * Debounced update handler for user presence changes
   */
  const debouncedUpdateUsers = useCallback(
    (() => {
      let timeoutId: NodeJS.Timeout | null = null;

      return () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        timeoutId = setTimeout(() => {
          if (awareness && collaborationEnabled) {
            const users = awareness.activeUsers;
            const uiUsers: IUIUser[] = users.map(user => ({
              ...user,
              animationState: 'stable'
            }));
            setActiveUsers(uiUsers);
            setConnectionStatus(awareness.isEnabled);
          }
        }, 50); // 50ms debounce as specified
      };
    })(),
    [awareness, collaborationEnabled]
  );

  /**
   * Handle user join events with smooth animations
   */
  const handleUserJoin = useCallback((sender: CollaborationAwareness, user: ICollaborativeUser) => {
    if (!collaborationEnabled) return;

    const uiUser: IUIUser = {
      ...user,
      animationState: 'entering'
    };

    setActiveUsers(prevUsers => {
      // Check if user already exists
      const existingIndex = prevUsers.findIndex(u => u.userId === user.userId);
      if (existingIndex !== -1) {
        // Update existing user
        const updatedUsers = [...prevUsers];
        updatedUsers[existingIndex] = uiUser;
        return updatedUsers;
      }

      // Add new user
      return [...prevUsers, uiUser];
    });

    // Transition to stable state after animation
    setTimeout(() => {
      setActiveUsers(prevUsers =>
        prevUsers.map(u =>
          u.userId === user.userId
            ? { ...u, animationState: 'stable' }
            : u
        )
      );
    }, 300); // Animation duration
  }, [collaborationEnabled]);

  /**
   * Handle user leave events with smooth animations
   */
  const handleUserLeave = useCallback((sender: CollaborationAwareness, user: ICollaborativeUser) => {
    if (!collaborationEnabled) return;

    // Start leaving animation
    setActiveUsers(prevUsers =>
      prevUsers.map(u =>
        u.userId === user.userId
          ? { ...u, animationState: 'leaving' }
          : u
      )
    );

    // Remove user after animation
    setTimeout(() => {
      setActiveUsers(prevUsers =>
        prevUsers.filter(u => u.userId !== user.userId)
      );
    }, 300); // Animation duration
  }, [collaborationEnabled]);

  /**
   * Set up awareness event subscriptions and cleanup
   */
  useEffect(() => {
    if (!awareness || !collaborationEnabled) {
      setActiveUsers([]);
      setConnectionStatus(false);
      return;
    }

    // Connect event handlers
    awareness.onUserJoin.connect(handleUserJoin);
    awareness.onUserLeave.connect(handleUserLeave);

    // Initial user list update
    debouncedUpdateUsers();

    // Cleanup function
    return () => {
      if (awareness) {
        awareness.onUserJoin.disconnect(handleUserJoin);
        awareness.onUserLeave.disconnect(handleUserLeave);
      }
    };
  }, [awareness, collaborationEnabled, handleUserJoin, handleUserLeave, debouncedUpdateUsers]);

  /**
   * Toggle collaboration mode
   */
  const handleCollaborationToggle = useCallback(() => {
    const newEnabled = !collaborationEnabled;
    setCollaborationEnabled(newEnabled);

    if (!newEnabled) {
      setActiveUsers([]);
      setConnectionStatus(false);
    } else {
      debouncedUpdateUsers();
    }
  }, [collaborationEnabled, debouncedUpdateUsers]);

  /**
   * Handle user avatar hover states
   */
  const handleUserHover = useCallback((userId: string, isHovered: boolean) => {
    setHoveredUserId(isHovered ? userId : null);
  }, []);

  /**
   * Generate initials from display name for avatar fallback
   */
  const generateInitials = useCallback((displayName: string): string => {
    return displayName
      .split(' ')
      .slice(0, 2)
      .map(name => name.charAt(0).toUpperCase())
      .join('');
  }, []);

  /**
   * Handle menu toggle
   */
  const handleMenuToggle = useCallback(() => {
    setShowMenu(prev => !prev);
  }, []);

  /**
   * Handle clicking outside menu to close it
   */
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (showMenu && !target.closest('.jp-CollaborationBar-menu')) {
        setShowMenu(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showMenu]);

  /**
   * Render user avatar with tooltip and hover effects
   */
  const renderUserAvatar = useCallback((user: IUIUser) => {
    const isHovered = hoveredUserId === user.userId;
    const animationClass = user.animationState ? `jp-CollaborationBar-user-${user.animationState}` : '';

    return (
      <div
        key={user.userId}
        className={`jp-CollaborationBar-user ${animationClass}`}
        onMouseEnter={() => handleUserHover(user.userId, true)}
        onMouseLeave={() => handleUserHover(user.userId, false)}
        title={`${user.displayName} (${user.isActive ? 'Active' : 'Idle'})`}
        style={{
          borderColor: user.color,
          transform: isHovered ? 'scale(1.1)' : 'scale(1)',
          transition: 'transform 0.2s ease, border-color 0.2s ease'
        }}
      >
        {user.avatar ? (
          <img
            src={user.avatar}
            alt={user.displayName}
            className="jp-CollaborationBar-user-avatar"
          />
        ) : (
          <div
            className="jp-CollaborationBar-user-initials"
            style={{ backgroundColor: user.color }}
          >
            {generateInitials(user.displayName)}
          </div>
        )}

        {/* Active status indicator */}
        <div
          className={`jp-CollaborationBar-user-status ${
            user.isActive ? 'jp-CollaborationBar-user-active' : 'jp-CollaborationBar-user-idle'
          }`}
        />
      </div>
    );
  }, [hoveredUserId, handleUserHover, generateInitials]);

  return (
    <div className="jp-CollaborationBar">
      {/* Connection Status Indicator */}
      <div className="jp-CollaborationBar-status">
        <div
          className={`jp-CollaborationBar-status-icon ${
            connectionStatus ? 'jp-CollaborationBar-connected' : 'jp-CollaborationBar-disconnected'
          }`}
          title={connectionStatus ? trans.__('Connected to collaboration server') : trans.__('Disconnected from collaboration server')}
        />
      </div>

      {/* Collaboration Toggle */}
      <button
        className={`jp-CollaborationBar-toggle ${
          collaborationEnabled ? 'jp-CollaborationBar-toggle-on' : 'jp-CollaborationBar-toggle-off'
        }`}
        onClick={handleCollaborationToggle}
        title={collaborationEnabled ? trans.__('Disable collaboration') : trans.__('Enable collaboration')}
      >
        {trans.__('Collaboration')}: {collaborationEnabled ? trans.__('ON') : trans.__('OFF')}
      </button>

      {/* Active Users Display */}
      {collaborationEnabled && (
        <div className="jp-CollaborationBar-users">
          <div className="jp-CollaborationBar-users-list">
            {activeUsers.map(renderUserAvatar)}
          </div>

          {/* Active User Count Badge */}
          {activeUsers.length > 0 && (
            <div className="jp-CollaborationBar-count-badge">
              {activeUsers.length}
            </div>
          )}
        </div>
      )}

      {/* Menu Dropdown */}
      {collaborationEnabled && (
        <div className="jp-CollaborationBar-menu">
          <button
            className="jp-CollaborationBar-menu-trigger"
            onClick={handleMenuToggle}
            title={trans.__('Collaboration options')}
          >
            ⋯
          </button>

          {showMenu && (
            <div className="jp-CollaborationBar-menu-dropdown">
              <button className="jp-CollaborationBar-menu-item">
                {trans.__('View History')}
              </button>
              <button className="jp-CollaborationBar-menu-item">
                {trans.__('Manage Permissions')}
              </button>
              <button className="jp-CollaborationBar-menu-item">
                {trans.__('Export Session')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Static namespace for CollaborationBar factory methods
 */
export namespace CollaborationBarWidget {
  /**
   * Create a new CollaborationBar ReactWidget instance
   *
   * @param awareness - The collaboration awareness service
   * @param notebookTracker - The notebook tracker service
   * @param translator - The translation service
   * @returns A new ReactWidget containing the CollaborationBar component
   */
  export const create = ({
    awareness,
    notebookTracker,
    translator
  }: {
    awareness: CollaborationAwareness;
    notebookTracker: INotebookTracker;
    translator: ITranslator;
  }): ReactWidget => {
    return ReactWidget.create(
      <CollaborationBarComponent
        awareness={awareness}
        notebookTracker={notebookTracker}
        translator={translator}
      />
    );
  };
}

/**
 * CollaborationBar class implementing ICollaborationBar interface for widget management
 */
export class CollaborationBar {
  private _widget: ReactWidget;
  private _awareness: CollaborationAwareness;
  private _disposed: boolean = false;

  /**
   * Create a new CollaborationBar instance
   */
  constructor(
    awareness: CollaborationAwareness,
    notebookTracker: INotebookTracker,
    translator: ITranslator
  ) {
    this._awareness = awareness;
    this._widget = CollaborationBarWidget.create({
      awareness,
      notebookTracker,
      translator
    });
  }

  /**
   * Get the underlying ReactWidget instance
   */
  get widget(): ReactWidget {
    return this._widget;
  }

  /**
   * Update the presence information for active users
   */
  updatePresence(users: ICollaborativeUser[]): void {
    if (this._disposed) {
      return;
    }

    // The React component handles presence updates automatically through awareness signals
    // This method is provided for compatibility with the ICollaborationBar interface
    console.log('CollaborationBar: Presence updated with', users.length, 'users');
  }

  /**
   * Show the current connection status
   */
  showConnectionStatus(connected: boolean): void {
    if (this._disposed) {
      return;
    }

    // The React component handles connection status automatically through awareness
    // This method is provided for compatibility with the ICollaborationBar interface
    console.log('CollaborationBar: Connection status updated:', connected);
  }

  /**
   * Add a new user to the presence display
   */
  addUser(user: ICollaborativeUser): void {
    if (this._disposed) {
      return;
    }

    // The React component handles user additions automatically through awareness signals
    // This method is provided for compatibility with the ICollaborationBar interface
    console.log('CollaborationBar: User added:', user.displayName);
  }

  /**
   * Remove a user from the presence display
   */
  removeUser(userId: string): void {
    if (this._disposed) {
      return;
    }

    // The React component handles user removals automatically through awareness signals
    // This method is provided for compatibility with the ICollaborationBar interface
    console.log('CollaborationBar: User removed:', userId);
  }

  /**
   * Get the list of currently active users
   */
  getActiveUsers(): ICollaborativeUser[] {
    if (this._disposed || !this._awareness) {
      return [];
    }

    return this._awareness.activeUsers;
  }

  /**
   * Dispose of the collaboration bar and clean up resources
   */
  dispose(): void {
    if (this._disposed) {
      return;
    }

    this._disposed = true;

    if (this._widget && !this._widget.isDisposed) {
      this._widget.dispose();
    }

    console.log('CollaborationBar disposed');
  }
}
