/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { ReactWidget } from '@jupyterlab/apputils';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';

import React, { useState, useEffect, useCallback } from 'react';

// Temporary relative imports for validation (would be package imports in production)
import { CollaborationAwareness } from '../../../notebook/src/collab/awareness';
import { ICollaborativeUser } from '../../../notebook/src/tokens';

/**
 * CSS classes for the CollaborationBar component following JupyterLab naming conventions
 */
const COLLABORATION_BAR_CLASS = 'jp-CollaborationBar';
const CONNECTION_STATUS_CLASS = 'jp-CollaborationBar-connection';
const USER_LIST_CLASS = 'jp-CollaborationBar-userList';
const USER_AVATAR_CLASS = 'jp-CollaborationBar-avatar';
const USER_COUNT_CLASS = 'jp-CollaborationBar-count';
const MENU_BUTTON_CLASS = 'jp-CollaborationBar-menu';
const TOGGLE_BUTTON_CLASS = 'jp-CollaborationBar-toggle';

/**
 * Props interface for the CollaborationBar component
 */
interface ICollaborationBarProps {
  /**
   * The collaboration awareness service for tracking user presence
   */
  awareness: CollaborationAwareness;

  /**
   * The notebook tracker service for monitoring active notebooks
   */
  notebookTracker: INotebookTracker;

  /**
   * The translation service for internationalization
   */
  translator: ITranslator;
}

/**
 * A React component to display collaboration status, active users, and collaboration controls.
 */
const CollaborationBarComponent = ({
  awareness,
  notebookTracker,
  translator,
}: ICollaborationBarProps): JSX.Element => {
  const trans = translator.load('notebook');

  // State management with proper initialization
  const [activeUsers, setActiveUsers] = useState<ICollaborativeUser[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<boolean>(false);
  const [collaborationEnabled, setCollaborationEnabled] = useState<boolean>(true);
  const [userHover, setUserHover] = useState<string | null>(null);

  // Debounced update handler to prevent excessive re-renders
  const debouncedUserUpdate = useCallback(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    const updateUsers = () => {
      if (awareness && awareness.isEnabled) {
        const users = awareness.activeUsers || [];
        setActiveUsers([...users]);
        setConnectionStatus(awareness.isEnabled);
      } else {
        setActiveUsers([]);
        setConnectionStatus(false);
      }
    };

    return () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(updateUsers, 50); // 50ms debounce as specified
    };
  }, [awareness]);

  // Effect for setting up awareness event listeners
  useEffect(() => {
    if (!awareness) {
      return;
    }

    const updateHandler = debouncedUserUpdate();

    // Subscribe to user join/leave events
    let onUserJoinDisposable: any = null;
    let onUserLeaveDisposable: any = null;

    try {
      if (awareness.onUserJoin && typeof awareness.onUserJoin.connect === 'function') {
        onUserJoinDisposable = awareness.onUserJoin.connect(() => {
          updateHandler();
        });
      }

      if (awareness.onUserLeave && typeof awareness.onUserLeave.connect === 'function') {
        onUserLeaveDisposable = awareness.onUserLeave.connect(() => {
          updateHandler();
        });
      }
    } catch (error) {
      console.warn('Failed to connect to awareness events:', error);
    }

    // Initial update
    updateHandler();
    setCollaborationEnabled(awareness.isEnabled);

    // Cleanup function
    return () => {
      if (onUserJoinDisposable && typeof onUserJoinDisposable.dispose === 'function') {
        onUserJoinDisposable.dispose();
      }
      if (onUserLeaveDisposable && typeof onUserLeaveDisposable.dispose === 'function') {
        onUserLeaveDisposable.dispose();
      }
    };
  }, [awareness, debouncedUserUpdate]);

  // Handler for collaboration toggle
  const handleCollaborationToggle = useCallback(() => {
    if (awareness) {
      // Note: This would typically interact with a collaboration service
      // For now, we update the local state
      const newState = !collaborationEnabled;
      setCollaborationEnabled(newState);

      if (!newState) {
        setActiveUsers([]);
        setConnectionStatus(false);
      }
    }
  }, [awareness, collaborationEnabled]);

  // Handler for menu dropdown (history/permissions)
  const handleMenuClick = useCallback(() => {
    // This would typically open a dropdown menu
    // Implementation would depend on JupyterLab's menu system
    console.log('Collaboration menu clicked - would open history/permissions');
  }, []);

  // Render user avatar with tooltip
  const renderUserAvatar = useCallback((user: ICollaborativeUser) => {
    const isHovered = userHover === user.userId;

    return (
      <div
        key={user.userId}
        className={USER_AVATAR_CLASS}
        style={{
          backgroundColor: user.color,
          border: `2px solid ${user.color}`,
          borderRadius: '50%',
          width: '28px',
          height: '28px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 2px',
          fontSize: '12px',
          fontWeight: 'bold',
          color: 'white',
          cursor: 'pointer',
          transition: 'transform 0.2s ease',
          transform: isHovered ? 'scale(1.1)' : 'scale(1)',
          position: 'relative'
        }}
        title={`${user.displayName} (${user.username})\nLast active: ${user.lastActivity.toLocaleTimeString()}`}
        onMouseEnter={() => setUserHover(user.userId)}
        onMouseLeave={() => setUserHover(null)}
      >
        {user.avatar ? (
          <img src={user.avatar} alt={user.displayName} style={{ width: '24px', height: '24px', borderRadius: '50%' }} />
        ) : (
          user.displayName.charAt(0).toUpperCase()
        )}
      </div>
    );
  }, [userHover]);

  // Connection status icon
  const connectionIcon = connectionStatus ? (
    <div
      className={CONNECTION_STATUS_CLASS}
      style={{
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: '#4caf50',
        marginRight: '8px'
      }}
      title={trans.__('Connected to collaboration server')}
    />
  ) : (
    <div
      className={CONNECTION_STATUS_CLASS}
      style={{
        display: 'inline-block',
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: '#f44336',
        marginRight: '8px'
      }}
      title={trans.__('Disconnected from collaboration server')}
    />
  );

  return (
    <div
      className={COLLABORATION_BAR_CLASS}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '4px 8px',
        backgroundColor: 'var(--jp-layout-color1)',
        borderBottom: '1px solid var(--jp-border-color1)',
        fontSize: '13px',
        height: '32px'
      }}
    >
      {/* Connection Status */}
      {connectionIcon}

      {/* Collaboration Toggle */}
      <button
        className={TOGGLE_BUTTON_CLASS}
        onClick={handleCollaborationToggle}
        style={{
          background: 'none',
          border: '1px solid var(--jp-border-color2)',
          borderRadius: '4px',
          padding: '2px 8px',
          marginRight: '12px',
          color: collaborationEnabled ? 'var(--jp-ui-font-color1)' : 'var(--jp-ui-font-color2)',
          cursor: 'pointer',
          fontSize: '12px'
        }}
        title={trans.__(`${collaborationEnabled ? 'Disable' : 'Enable'} collaboration features`)}
      >
        {trans.__(`Collaboration: ${collaborationEnabled ? 'ON' : 'OFF'}`)}
      </button>

      {/* Active Users List */}
      <div className={USER_LIST_CLASS} style={{ display: 'flex', alignItems: 'center', marginRight: '8px' }}>
        {activeUsers.length > 0 && collaborationEnabled ? (
          <>
            {activeUsers.slice(0, 5).map(renderUserAvatar)}
            {activeUsers.length > 5 && (
              <div
                className={USER_AVATAR_CLASS}
                style={{
                  backgroundColor: 'var(--jp-border-color2)',
                  border: '2px solid var(--jp-border-color2)',
                  borderRadius: '50%',
                  width: '28px',
                  height: '28px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 2px',
                  fontSize: '10px',
                  color: 'var(--jp-ui-font-color1)',
                  cursor: 'pointer'
                }}
                title={trans.__(`${activeUsers.length - 5} more users`)}
              >
                +{activeUsers.length - 5}
              </div>
            )}
          </>
        ) : (
          collaborationEnabled && (
            <span style={{ color: 'var(--jp-ui-font-color2)', fontSize: '12px' }}>
              {trans.__('No other users')}
            </span>
          )
        )}
      </div>

      {/* User Count Badge */}
      {activeUsers.length > 0 && collaborationEnabled && (
        <div
          className={USER_COUNT_CLASS}
          style={{
            backgroundColor: 'var(--jp-brand-color1)',
            color: 'white',
            borderRadius: '10px',
            padding: '2px 6px',
            fontSize: '11px',
            fontWeight: 'bold',
            marginRight: '8px'
          }}
          title={trans.__(`${activeUsers.length} active users`)}
        >
          {activeUsers.length}
        </div>
      )}

      {/* Menu Dropdown Button */}
      {collaborationEnabled && (
        <button
          className={MENU_BUTTON_CLASS}
          onClick={handleMenuClick}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--jp-ui-font-color1)',
            cursor: 'pointer',
            padding: '4px',
            borderRadius: '2px'
          }}
          title={trans.__('Collaboration options (History, Permissions)')}
        >
          ⋮
        </button>
      )}
    </div>
  );
};

/**
 * CollaborationBar class implementing the ICollaborationBar interface
 */
export class CollaborationBar {
  private _widget: ReactWidget | null = null;
  private _activeUsers: ICollaborativeUser[] = [];

  /**
   * Create a new CollaborationBar ReactWidget
   */
  static create({
    awareness,
    notebookTracker,
    translator,
  }: {
    awareness: CollaborationAwareness;
    notebookTracker: INotebookTracker;
    translator: ITranslator;
  }): ReactWidget {
    const collaborationBar = new CollaborationBar();
    collaborationBar._widget = ReactWidget.create(
      <CollaborationBarComponent
        awareness={awareness}
        notebookTracker={notebookTracker}
        translator={translator}
      />
    );
    return collaborationBar._widget;
  }

  /**
   * Update the presence information for active users.
   */
  updatePresence(users: ICollaborativeUser[]): void {
    this._activeUsers = [...users];
    // Note: In a real implementation, this would trigger a React state update
    // through a context or prop callback mechanism
    console.log('Presence updated with', users.length, 'users');
  }

  /**
   * Show the current connection status.
   */
  showConnectionStatus(connected: boolean): void {
    // Note: In a real implementation, this would trigger a React state update
    // through a context or prop callback mechanism
    console.log('Connection status updated:', connected);
  }

  /**
   * Add a new user to the presence display.
   */
  addUser(user: ICollaborativeUser): void {
    const existingIndex = this._activeUsers.findIndex(u => u.userId === user.userId);
    if (existingIndex === -1) {
      this._activeUsers.push(user);
      console.log('User added to collaboration bar:', user.displayName);
    } else {
      // Update existing user
      this._activeUsers[existingIndex] = user;
      console.log('User updated in collaboration bar:', user.displayName);
    }
  }

  /**
   * Remove a user from the presence display.
   */
  removeUser(userId: string): void {
    const initialLength = this._activeUsers.length;
    this._activeUsers = this._activeUsers.filter(user => user.userId !== userId);

    if (this._activeUsers.length < initialLength) {
      console.log('User removed from collaboration bar:', userId);
    }
  }

  /**
   * Get the list of currently active users.
   */
  getActiveUsers(): ICollaborativeUser[] {
    return [...this._activeUsers];
  }
}
