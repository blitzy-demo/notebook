// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import React, { useState, useEffect, useCallback } from 'react';
import { Dialog, ReactWidget } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { closeIcon } from '@jupyterlab/ui-components';
import { ICollaborativeRole } from '../../../notebook/src/collab/permissions';
import { YjsNotebookProvider } from '../../../notebook/src/collab/provider';
import { UserAwareness } from '../../../notebook/src/collab/awareness';

/**
 * Interface for user permission entry in the dialog
 */
interface IUserPermissionEntry {
  /** User identifier */
  userId: string;
  /** Username for display */
  username: string;
  /** User email address */
  email: string;
  /** Display name */
  displayName: string;
  /** Current permission level */
  permissionLevel: string;
  /** Whether this is the current user */
  isCurrentUser: boolean;
  /** Whether user is currently active */
  isActive: boolean;
  /** User avatar URL or data */
  avatar?: string;
  /** User color for presence indicators */
  color?: string;
}

/**
 * Props for the PermissionsDialog component
 */
interface IPermissionsDialogProps {
  /** Collaboration provider for session information */
  provider: YjsNotebookProvider;
  /** User awareness system */
  awareness: UserAwareness;
  /** Permissions system for access control */
  permissions: any;
  /** Translator for internationalization */
  translator: ITranslator;
  /** Notebook path for permission context */
  notebookPath: string;
  /** Callback when dialog is closed */
  onClose?: () => void;
  /** Callback when permissions are updated */
  onPermissionsUpdated?: (users: IUserPermissionEntry[]) => void;
}

/**
 * Available permission levels for the dropdown
 */
const PERMISSION_LEVELS = [
  { value: 'owner', label: 'Owner' },
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' }
];

/**
 * Permission level descriptions
 */
const PERMISSION_DESCRIPTIONS = {
  owner: 'Full control, can manage permissions',
  editor: 'Can edit cells, add comments',
  viewer: 'Can view and comment, but not edit'
};

/**
 * PermissionsDialog: React component for managing collaborative notebook access control
 *
 * This component provides a comprehensive interface for viewing and managing user permissions
 * in collaborative notebook sessions. It allows owners to add/remove users, modify permission
 * levels, and see real-time collaboration status.
 */
export class PermissionsDialog extends React.Component<IPermissionsDialogProps> {
  private _disposed = false;
  private _mounted = false;
  private _trans: any;

  constructor(props: IPermissionsDialogProps) {
    super(props);
    this._trans = props.translator.load('notebook');
    
    this.state = {
      users: [],
      loading: true,
      error: null,
      newUserInput: '',
      newUserPermissionLevel: 'viewer',
      isSubmitting: false,
      hasChanges: false
    };
  }

  /**
   * Component state interface
   */
  state: {
    users: IUserPermissionEntry[];
    loading: boolean;
    error: string | null;
    newUserInput: string;
    newUserPermissionLevel: string;
    isSubmitting: boolean;
    hasChanges: boolean;
  } = {
    users: [],
    loading: true,
    error: null,
    newUserInput: '',
    newUserPermissionLevel: 'viewer',
    isSubmitting: false,
    hasChanges: false
  };

  /**
   * Component lifecycle: Mount and initialize
   */
  componentDidMount(): void {
    this._mounted = true;
    this._initializeComponent();
  }

  /**
   * Component lifecycle: Cleanup
   */
  componentWillUnmount(): void {
    this._mounted = false;
    this._disposed = true;
  }

  /**
   * Initialize component data and event listeners
   */
  private async _initializeComponent(): Promise<void> {
    try {
      // Load current users and permissions
      await this._loadUsers();
      
      // Set up event listeners
      this._setupEventListeners();
      
      if (this._mounted) {
        this.setState({ loading: false });
      }
    } catch (error) {
      console.error('Failed to initialize permissions dialog:', error);
      if (this._mounted) {
        this.setState({ 
          loading: false, 
          error: this._trans.__('Failed to load permission data') 
        });
      }
    }
  }

  /**
   * Set up event listeners for real-time updates
   */
  private _setupEventListeners(): void {
    // Listen for user awareness changes
    this.props.awareness.onUsersChanged.connect(this._handleUsersChanged);
    
    // Listen for permission changes
    if (this.props.permissions.onPermissionChanged) {
      this.props.permissions.onPermissionChanged.connect(this._handlePermissionChanged);
    }
  }

  /**
   * Handle user awareness changes
   */
  private _handleUsersChanged = async (): Promise<void> => {
    if (this._disposed || !this._mounted) return;
    
    try {
      await this._loadUsers();
    } catch (error) {
      console.error('Failed to update users:', error);
    }
  };

  /**
   * Handle permission changes
   */
  private _handlePermissionChanged = async (): Promise<void> => {
    if (this._disposed || !this._mounted) return;
    
    try {
      await this._loadUsers();
    } catch (error) {
      console.error('Failed to update permissions:', error);
    }
  };

  /**
   * Load current users and their permission levels
   */
  private async _loadUsers(): Promise<void> {
    try {
      const currentUser = this.props.awareness.getCurrentUser();
      const activeUsers = this.props.awareness.getActiveUsers();
      const allUsers = this.props.awareness.users;
      
      const userEntries: IUserPermissionEntry[] = [];
      
      // Add current user first
      if (currentUser) {
        const role = await this.props.permissions.getCollaborativeRole(
          currentUser.userId, 
          this.props.notebookPath
        );
        
        userEntries.push({
          userId: currentUser.userId,
          username: currentUser.username,
          email: currentUser.email,
          displayName: currentUser.displayName,
          permissionLevel: role?.role || 'viewer',
          isCurrentUser: true,
          isActive: true,
          avatar: currentUser.avatar,
          color: currentUser.color
        });
      }
      
      // Add other users
      for (const [userId, user] of allUsers) {
        if (currentUser && userId === currentUser.userId) continue;
        
        const role = await this.props.permissions.getCollaborativeRole(
          userId, 
          this.props.notebookPath
        );
        
        userEntries.push({
          userId: userId,
          username: user.username,
          email: user.email,
          displayName: user.displayName,
          permissionLevel: role?.role || 'viewer',
          isCurrentUser: false,
          isActive: activeUsers.some(u => u.userId === userId),
          avatar: user.avatar,
          color: user.color
        });
      }
      
      if (this._mounted) {
        this.setState({ users: userEntries });
      }
    } catch (error) {
      console.error('Failed to load users:', error);
      if (this._mounted) {
        this.setState({ error: this._trans.__('Failed to load users') });
      }
    }
  }

  /**
   * Handle permission level change for a user
   */
  private _handlePermissionChange = useCallback(async (userId: string, newLevel: string): Promise<void> => {
    if (this._disposed || !this._mounted) return;
    
    try {
      // Update permission in the permissions system
      await this.props.permissions.setUserRole(userId, this.props.notebookPath, newLevel);
      
      // Update local state
      this.setState(prevState => ({
        ...prevState,
        users: prevState.users.map(user =>
          user.userId === userId
            ? { ...user, permissionLevel: newLevel }
            : user
        ),
        hasChanges: true
      }));
      
      // Notify parent of changes
      if (this.props.onPermissionsUpdated) {
        this.props.onPermissionsUpdated(this.state.users);
      }
    } catch (error) {
      console.error('Failed to update permission:', error);
      this.setState({ error: this._trans.__('Failed to update permission') });
    }
  }, [this.props.permissions, this.props.notebookPath, this.props.onPermissionsUpdated, this._trans]);

  /**
   * Handle user removal
   */
  private _handleRemoveUser = useCallback(async (userId: string): Promise<void> => {
    if (this._disposed || !this._mounted) return;
    
    try {
      // Remove user permissions
      await this.props.permissions.setUserRole(userId, this.props.notebookPath, 'none');
      
      // Update local state
      this.setState(prevState => ({
        ...prevState,
        users: prevState.users.filter(user => user.userId !== userId),
        hasChanges: true
      }));
      
      // Notify parent of changes
      if (this.props.onPermissionsUpdated) {
        this.props.onPermissionsUpdated(this.state.users);
      }
    } catch (error) {
      console.error('Failed to remove user:', error);
      this.setState({ error: this._trans.__('Failed to remove user') });
    }
  }, [this.props.permissions, this.props.notebookPath, this.props.onPermissionsUpdated, this._trans]);

  /**
   * Handle new user input change
   */
  private _handleNewUserInputChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    this.setState({ newUserInput: event.target.value });
  }, []);

  /**
   * Handle new user permission level change
   */
  private _handleNewUserPermissionLevelChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>): void => {
    this.setState({ newUserPermissionLevel: event.target.value });
  }, []);

  /**
   * Handle adding a new user
   */
  private _handleAddUser = useCallback(async (): Promise<void> => {
    if (this._disposed || !this._mounted) return;
    
    const { newUserInput, newUserPermissionLevel } = this.state;
    
    if (!newUserInput.trim()) {
      this.setState({ error: this._trans.__('Please enter a username or email') });
      return;
    }
    
    this.setState({ isSubmitting: true, error: null });
    
    try {
      // Add user with specified permission level
      await this.props.permissions.setUserRole(
        newUserInput.trim(), 
        this.props.notebookPath, 
        newUserPermissionLevel
      );
      
      // Create new user entry
      const newUser: IUserPermissionEntry = {
        userId: newUserInput.trim(),
        username: newUserInput.trim(),
        email: newUserInput.includes('@') ? newUserInput.trim() : '',
        displayName: newUserInput.trim(),
        permissionLevel: newUserPermissionLevel,
        isCurrentUser: false,
        isActive: false
      };
      
      // Update local state
      this.setState(prevState => ({
        ...prevState,
        users: [...prevState.users, newUser],
        newUserInput: '',
        newUserPermissionLevel: 'viewer',
        isSubmitting: false,
        hasChanges: true
      }));
      
      // Notify parent of changes
      if (this.props.onPermissionsUpdated) {
        this.props.onPermissionsUpdated([...this.state.users, newUser]);
      }
    } catch (error) {
      console.error('Failed to add user:', error);
      this.setState({ 
        error: this._trans.__('Failed to add user'), 
        isSubmitting: false 
      });
    }
  }, [
    this.state.newUserInput, 
    this.state.newUserPermissionLevel, 
    this.props.permissions, 
    this.props.notebookPath, 
    this.props.onPermissionsUpdated, 
    this._trans
  ]);

  /**
   * Handle save changes
   */
  private _handleSaveChanges = useCallback(async (): Promise<void> => {
    if (this._disposed || !this._mounted) return;
    
    this.setState({ isSubmitting: true, error: null });
    
    try {
      // All changes are applied immediately, so just close the dialog
      this.setState({ hasChanges: false, isSubmitting: false });
      
      if (this.props.onClose) {
        this.props.onClose();
      }
    } catch (error) {
      console.error('Failed to save changes:', error);
      this.setState({ 
        error: this._trans.__('Failed to save changes'), 
        isSubmitting: false 
      });
    }
  }, [this.props.onClose, this._trans]);

  /**
   * Handle cancel dialog
   */
  private _handleCancel = useCallback((): void => {
    if (this.props.onClose) {
      this.props.onClose();
    }
  }, [this.props.onClose]);

  /**
   * Render user permission entry row
   */
  private _renderUserRow = (user: IUserPermissionEntry): JSX.Element => {
    const canModify = !user.isCurrentUser && 
                     this.state.users.find(u => u.isCurrentUser)?.permissionLevel === 'owner';
    
    return (
      <tr key={user.userId} className="jp-PermissionsDialog-userRow">
        <td className="jp-PermissionsDialog-userInfo">
          <div className="jp-PermissionsDialog-userContainer">
            {user.avatar && (
              <img 
                src={user.avatar} 
                alt={user.displayName} 
                className="jp-PermissionsDialog-userAvatar"
              />
            )}
            {user.color && !user.avatar && (
              <div 
                className="jp-PermissionsDialog-userColorIndicator"
                style={{ backgroundColor: user.color }}
              />
            )}
            <div className="jp-PermissionsDialog-userDetails">
              <div className="jp-PermissionsDialog-userName">
                {user.displayName}
                {user.isCurrentUser && (
                  <span className="jp-PermissionsDialog-currentUserLabel">
                    {' (' + this._trans.__('You') + ')'}
                  </span>
                )}
              </div>
              <div className="jp-PermissionsDialog-userEmail">
                {user.email}
              </div>
            </div>
            {user.isActive && (
              <div className="jp-PermissionsDialog-activeIndicator">
                <span className="jp-PermissionsDialog-activeStatus">
                  {this._trans.__('Active')}
                </span>
              </div>
            )}
          </div>
        </td>
        <td className="jp-PermissionsDialog-permissionLevel">
          <select
            value={user.permissionLevel}
            onChange={(e) => this._handlePermissionChange(user.userId, e.target.value)}
            disabled={!canModify}
            className="jp-PermissionsDialog-permissionSelect"
          >
            {PERMISSION_LEVELS.map(level => (
              <option key={level.value} value={level.value}>
                {this._trans.__(level.label)}
              </option>
            ))}
          </select>
        </td>
        <td className="jp-PermissionsDialog-actions">
          {canModify && (
            <button
              onClick={() => this._handleRemoveUser(user.userId)}
              className="jp-PermissionsDialog-removeButton"
              title={this._trans.__('Remove user')}
            >
              <closeIcon.react />
            </button>
          )}
        </td>
      </tr>
    );
  };

  /**
   * Render the main dialog content
   */
  render(): JSX.Element {
    const { loading, error, users, newUserInput, newUserPermissionLevel, isSubmitting } = this.state;
    
    if (loading) {
      return (
        <div className="jp-PermissionsDialog-loading">
          <div className="jp-PermissionsDialog-loadingSpinner" />
          <p>{this._trans.__('Loading permissions...')}</p>
        </div>
      );
    }
    
    return (
      <div className="jp-PermissionsDialog">
        <div className="jp-PermissionsDialog-header">
          <h2 className="jp-PermissionsDialog-title">
            🔒 {this._trans.__('Collaboration Permissions')} - {this.props.notebookPath}
          </h2>
        </div>
        
        {error && (
          <div className="jp-PermissionsDialog-error">
            <p>{error}</p>
          </div>
        )}
        
        <div className="jp-PermissionsDialog-content">
          <div className="jp-PermissionsDialog-usersSection">
            <table className="jp-PermissionsDialog-usersTable">
              <thead>
                <tr>
                  <th>{this._trans.__('User')}</th>
                  <th>{this._trans.__('Access Level')}</th>
                  <th>{this._trans.__('Actions')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map(this._renderUserRow)}
              </tbody>
            </table>
          </div>
          
          <div className="jp-PermissionsDialog-addUserSection">
            <h3 className="jp-PermissionsDialog-addUserTitle">
              {this._trans.__('Add Collaborators:')}
            </h3>
            <div className="jp-PermissionsDialog-addUserForm">
              <input
                type="text"
                value={newUserInput}
                onChange={this._handleNewUserInputChange}
                placeholder={this._trans.__('Email or username')}
                className="jp-PermissionsDialog-addUserInput"
                disabled={isSubmitting}
              />
              <select
                value={newUserPermissionLevel}
                onChange={this._handleNewUserPermissionLevelChange}
                className="jp-PermissionsDialog-addUserPermissionSelect"
                disabled={isSubmitting}
              >
                {PERMISSION_LEVELS.map(level => (
                  <option key={level.value} value={level.value}>
                    {this._trans.__(level.label)}
                  </option>
                ))}
              </select>
              <button
                onClick={this._handleAddUser}
                disabled={isSubmitting || !newUserInput.trim()}
                className="jp-PermissionsDialog-addUserButton"
              >
                {isSubmitting ? this._trans.__('Adding...') : this._trans.__('Add')}
              </button>
            </div>
          </div>
          
          <div className="jp-PermissionsDialog-legend">
            <h4>{this._trans.__('Access Levels:')}</h4>
            <ul>
              {Object.entries(PERMISSION_DESCRIPTIONS).map(([level, description]) => (
                <li key={level}>
                  <strong>{this._trans.__(level.charAt(0).toUpperCase() + level.slice(1))}</strong>: {this._trans.__(description)}
                </li>
              ))}
            </ul>
          </div>
        </div>
        
        <div className="jp-PermissionsDialog-footer">
          <button
            onClick={this._handleCancel}
            className="jp-PermissionsDialog-cancelButton"
            disabled={isSubmitting}
          >
            {this._trans.__('Cancel')}
          </button>
          <button
            onClick={this._handleSaveChanges}
            className="jp-PermissionsDialog-saveButton"
            disabled={isSubmitting}
          >
            {isSubmitting ? this._trans.__('Saving...') : this._trans.__('Save Changes')}
          </button>
        </div>
      </div>
    );
  }

  /**
   * Show the permissions dialog
   */
  static async showDialog(options: {
    provider: YjsNotebookProvider;
    awareness: UserAwareness;
    permissions: any;
    translator: ITranslator;
    notebookPath: string;
  }): Promise<Dialog.IResult<void>> {
    const { provider, awareness, permissions, translator, notebookPath } = options;
    
    const body = ReactWidget.create(
      <PermissionsDialog
        provider={provider}
        awareness={awareness}
        permissions={permissions}
        translator={translator}
        notebookPath={notebookPath}
      />
    );
    
    const dialog = new Dialog({
      title: translator.load('notebook').__('Collaboration Permissions'),
      body,
      buttons: [], // Buttons are handled by the component
      hasClose: true,
      focusNodeSelector: '.jp-PermissionsDialog-addUserInput'
    });
    
    return dialog.launch();
  }

  /**
   * Hide the dialog
   */
  hideDialog(): void {
    if (this.props.onClose) {
      this.props.onClose();
    }
  }

  /**
   * Update permissions programmatically
   */
  async updatePermissions(userId: string, permissionLevel: string): Promise<void> {
    await this._handlePermissionChange(userId, permissionLevel);
  }

  /**
   * Invite user programmatically
   */
  async inviteUser(userIdentifier: string, permissionLevel: string): Promise<void> {
    this.setState({ 
      newUserInput: userIdentifier, 
      newUserPermissionLevel: permissionLevel 
    });
    await this._handleAddUser();
  }

  /**
   * Get current users for external access
   */
  get props(): { permissions: any; users: IUserPermissionEntry[] } {
    return {
      permissions: this.props.permissions,
      users: this.state.users
    };
  }
}

export default PermissionsDialog;