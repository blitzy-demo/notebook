import { ReactWidget, showDialog } from '@jupyterlab/apputils';
import { ITranslator } from '@jupyterlab/translation';
import { Token } from '@lumino/coreutils';
import React, { useState, useEffect } from 'react';

import {
  IPermissionsManager,
  IAccessControlList,
  IYjsNotebookProvider
} from '../../application/src/tokens';

/**
 * CSS classes for styling the permissions dialog
 */
const PERMISSIONS_DIALOG_CLASS = 'jp-PermissionsDialog';
const USER_LIST_CLASS = 'jp-PermissionsDialog-userList';
const USER_ITEM_CLASS = 'jp-PermissionsDialog-userItem';
const ROLE_SELECT_CLASS = 'jp-PermissionsDialog-roleSelect';
const ADD_USER_SECTION_CLASS = 'jp-PermissionsDialog-addUser';
const SHARE_SECTION_CLASS = 'jp-PermissionsDialog-share';
const BUTTON_CLASS = 'jp-PermissionsDialog-button';
const INPUT_CLASS = 'jp-PermissionsDialog-input';

/**
 * Interface for the permissions dialog component props.
 */
interface IPermissionsDialogProps {
  /**
   * The permissions manager service.
   */
  permissionsManager: IPermissionsManager;

  /**
   * The access control list service.
   */
  accessControlList: IAccessControlList;

  /**
   * The Yjs notebook provider for collaboration.
   */
  yjsProvider: IYjsNotebookProvider;

  /**
   * The translation service.
   */
  translator: ITranslator;

  /**
   * The current notebook path.
   */
  notebookPath: string;

  /**
   * Callback when dialog is closed.
   */
  onClose?: () => void;
}

/**
 * Interface for user information in the permissions dialog.
 */
interface IUserPermissionInfo {
  userId: string;
  name: string;
  email?: string;
  avatar?: string;
  role: IPermissionsManager.Role;
  addedAt: number;
  isCurrentUser: boolean;
}

/**
 * Share link preset configurations.
 */
interface ISharePreset {
  name: string;
  description: string;
  role: IPermissionsManager.Role;
  permissions: IPermissionsManager.Permission[];
}

/**
 * Predefined share link presets for different collaboration scenarios.
 */
const SHARE_PRESETS: ISharePreset[] = [
  {
    name: 'View Only',
    description: 'Recipients can view the notebook but cannot edit',
    role: 'viewer',
    permissions: ['read']
  },
  {
    name: 'Can Edit',
    description: 'Recipients can view and edit the notebook',
    role: 'editor',
    permissions: ['read', 'write', 'execute']
  },
  {
    name: 'Full Collaboration',
    description: 'Recipients can edit, comment, and use all collaboration features',
    role: 'collaborator',
    permissions: ['read', 'write', 'execute', 'comment', 'lock']
  },
  {
    name: 'Admin Access',
    description: 'Recipients have full administrative access including managing permissions',
    role: 'admin',
    permissions: ['read', 'write', 'execute', 'comment', 'lock', 'manage', 'history', 'share']
  }
];

/**
 * React component for the permissions dialog content.
 */
const PermissionsDialogContent: React.FC<IPermissionsDialogProps> = ({
  permissionsManager,
  accessControlList,
  yjsProvider,
  translator,
  notebookPath,
  onClose
}) => {
  const trans = translator.load('notebook');
  
  // State for managing users and their permissions
  const [users, setUsers] = useState<IUserPermissionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  
  // State for adding new users
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserRole, setNewUserRole] = useState<IPermissionsManager.Role>('editor');
  const [addingUser, setAddingUser] = useState(false);
  
  // State for share link generation
  const [selectedPreset, setSelectedPreset] = useState<ISharePreset>(SHARE_PRESETS[1]);
  const [generatedLink, setGeneratedLink] = useState('');
  const [shareLoading, setShareLoading] = useState(false);

  /**
   * Load users and their permissions from the permissions manager.
   */
  const loadUsers = async () => {
    try {
      setLoading(true);
      const allUsers = permissionsManager.getAllUsers();
      
      // Transform user data for the UI
      const userInfos: IUserPermissionInfo[] = allUsers.map(user => ({
        userId: user.userId,
        name: user.name,
        email: user.email,
        avatar: user.avatar,
        role: user.role,
        addedAt: user.addedAt,
        isCurrentUser: user.userId === getCurrentUserId()
      }));

      setUsers(userInfos);
      setError('');
    } catch (err) {
      setError(trans.__('Failed to load user permissions: %1', String(err)));
      console.error('Error loading users:', err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Get the current user ID from the collaboration provider.
   * Integrates with JupyterHub authentication when available.
   */
  const getCurrentUserId = (): string => {
    try {
      // Check if we're in a JupyterHub environment
      if (window.location.pathname.includes('/user/')) {
        // Extract user ID from JupyterHub URL pattern
        const pathParts = window.location.pathname.split('/');
        const userIndex = pathParts.indexOf('user');
        if (userIndex !== -1 && pathParts[userIndex + 1]) {
          return pathParts[userIndex + 1];
        }
      }
      
      // Try to get user info from the page data (JupyterHub injects this)
      const pageConfig = (window as any).jupyterapp?.page_config;
      if (pageConfig?.user) {
        return pageConfig.user.name || pageConfig.user.login || 'unknown-user';
      }
      
      // Fallback to checking for authentication headers or cookies
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'jupyterhub-user' || name === 'jupyter-user') {
          return decodeURIComponent(value);
        }
      }
      
      // Ultimate fallback
      return 'current-user';
    } catch (error) {
      console.warn('Failed to determine current user ID:', error);
      return 'current-user';
    }
  };

  /**
   * Handle role change for a user.
   */
  const handleRoleChange = async (userId: string, newRole: IPermissionsManager.Role) => {
    try {
      await permissionsManager.setUserRole(userId, newRole);
      
      // Update local state
      setUsers(prevUsers =>
        prevUsers.map(user =>
          user.userId === userId ? { ...user, role: newRole } : user
        )
      );
    } catch (err) {
      setError(trans.__('Failed to update user role: %1', String(err)));
      console.error('Error updating role:', err);
    }
  };

  /**
   * Resolve user information through JupyterHub API.
   */
  const resolveUserByEmail = async (email: string): Promise<{ userId: string; name: string; avatar?: string }> => {
    try {
      // Try to use JupyterHub API to resolve user
      const baseUrl = window.location.origin;
      const hubApiUrl = `${baseUrl}/hub/api/users`;
      
      // First, try to get user info from JupyterHub
      const response = await fetch(hubApiUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      
      if (response.ok) {
        const users = await response.json();
        const user = users.find((u: any) => u.email === email || u.name === email);
        if (user) {
          return {
            userId: user.name,
            name: user.display_name || user.name,
            avatar: user.avatar_url
          };
        }
      }
      
      // If JupyterHub API is not available or user not found, create a user entry
      // This assumes the email is the user identifier
      const username = email.includes('@') ? email.split('@')[0] : email;
      return {
        userId: username,
        name: username,
        avatar: undefined
      };
    } catch (error) {
      console.warn('Failed to resolve user through JupyterHub:', error);
      // Fallback to local user creation
      const username = email.includes('@') ? email.split('@')[0] : email;
      return {
        userId: username,
        name: username,
        avatar: undefined
      };
    }
  };

  /**
   * Validate email or username input.
   */
  const validateUserInput = (input: string): boolean => {
    const trimmed = input.trim();
    if (!trimmed) return false;
    
    // Check if it's a valid email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(trimmed)) return true;
    
    // Check if it's a valid username (alphanumeric, dashes, underscores)
    const usernameRegex = /^[a-zA-Z0-9_-]+$/;
    if (usernameRegex.test(trimmed) && trimmed.length >= 2) return true;
    
    return false;
  };

  /**
   * Handle adding a new user.
   */
  const handleAddUser = async () => {
    if (!validateUserInput(newUserEmail)) {
      setError(trans.__('Please enter a valid email address or username (2+ characters, letters, numbers, dashes, underscores only)'));
      return;
    }

    try {
      setAddingUser(true);
      setError('');

      // Check if user already exists
      const existingUser = users.find(u => 
        u.email === newUserEmail || u.userId === newUserEmail || u.name === newUserEmail
      );
      
      if (existingUser) {
        setError(trans.__('User already has access to this notebook'));
        return;
      }

      // Resolve user information through JupyterHub
      const userInfo = await resolveUserByEmail(newUserEmail);
      
      // Set the user role in the permissions manager
      await permissionsManager.setUserRole(userInfo.userId, newUserRole);
      
      // Add appropriate permissions based on role
      const rolePermissions = getRolePermissions(newUserRole);
      for (const permission of rolePermissions) {
        await permissionsManager.grantPermission(userInfo.userId, permission);
      }
      
      // Add to local state
      const newUser: IUserPermissionInfo = {
        userId: userInfo.userId,
        name: userInfo.name,
        email: newUserEmail.includes('@') ? newUserEmail : undefined,
        avatar: userInfo.avatar,
        role: newUserRole,
        addedAt: Date.now(),
        isCurrentUser: false
      };
      
      setUsers(prevUsers => [...prevUsers, newUser]);
      setNewUserEmail('');
      setNewUserRole('editor');
      
      // Show success message (optional)
      console.log(`Successfully added user ${userInfo.name} with role ${newUserRole}`);
    } catch (err) {
      setError(trans.__('Failed to add user: %1', String(err)));
      console.error('Error adding user:', err);
    } finally {
      setAddingUser(false);
    }
  };

  /**
   * Get permissions for a given role.
   */
  const getRolePermissions = (role: IPermissionsManager.Role): IPermissionsManager.Permission[] => {
    switch (role) {
      case 'viewer':
        return ['read'];
      case 'editor':
        return ['read', 'write', 'execute'];
      case 'collaborator':
        return ['read', 'write', 'execute', 'comment', 'lock'];
      case 'admin':
        return ['read', 'write', 'execute', 'comment', 'lock', 'manage', 'history', 'share'];
      default:
        return ['read'];
    }
  };

  /**
   * Handle removing a user.
   */
  const handleRemoveUser = async (userId: string) => {
    if (users.find(u => u.userId === userId)?.isCurrentUser) {
      setError(trans.__('Cannot remove yourself from the notebook'));
      return;
    }

    try {
      // Remove all permissions for the user
      const userPermissions = permissionsManager.getUserPermissions(userId);
      for (const permission of userPermissions.permissions) {
        await permissionsManager.revokePermission(userId, permission);
      }
      
      // Remove from local state
      setUsers(prevUsers => prevUsers.filter(user => user.userId !== userId));
    } catch (err) {
      setError(trans.__('Failed to remove user: %1', String(err)));
      console.error('Error removing user:', err);
    }
  };

  /**
   * Generate a share link with the selected preset permissions.
   */
  const handleGenerateShareLink = async () => {
    try {
      setShareLoading(true);
      setError('');

      // Generate a cryptographically secure token
      const shareToken = await generateSecureShareToken();
      
      // Create the share link with proper URL encoding
      const baseUrl = window.location.origin;
      const notebookPathEncoded = encodeURIComponent(notebookPath);
      const shareLink = `${baseUrl}/notebooks/${notebookPathEncoded}?share=${shareToken}&role=${selectedPreset.role}&permissions=${selectedPreset.permissions.join(',')}`;
      
      // Store the share token and its associated permissions on the server
      await storeShareToken(shareToken, {
        notebookPath,
        role: selectedPreset.role,
        permissions: selectedPreset.permissions,
        createdAt: Date.now(),
        createdBy: getCurrentUserId(),
        expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days expiration
      });
      
      setGeneratedLink(shareLink);
      
      console.log('Generated share link:', shareLink);
    } catch (err) {
      setError(trans.__('Failed to generate share link: %1', String(err)));
      console.error('Error generating share link:', err);
    } finally {
      setShareLoading(false);
    }
  };

  /**
   * Generate a cryptographically secure token for share links.
   */
  const generateSecureShareToken = async (): Promise<string> => {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      // Use Web Crypto API for secure random generation
      const array = new Uint8Array(24); // 192 bits
      crypto.getRandomValues(array);
      return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
    } else {
      // Fallback for older browsers
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      let result = '';
      for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    }
  };

  /**
   * Store share token and metadata on the server.
   */
  const storeShareToken = async (token: string, metadata: {
    notebookPath: string;
    role: IPermissionsManager.Role;
    permissions: IPermissionsManager.Permission[];
    createdAt: number;
    createdBy: string;
    expiresAt: number;
  }): Promise<void> => {
    try {
      // Try to store via the server API
      const response = await fetch('/api/collaboration/share-tokens', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          token,
          metadata
        })
      });

      if (!response.ok) {
        throw new Error(`Server responded with status ${response.status}`);
      }

      console.log('Share token stored successfully');
    } catch (error) {
      console.warn('Failed to store share token on server, using local storage fallback:', error);
      
      // Fallback to local storage (not secure for production)
      const shareTokens = JSON.parse(localStorage.getItem('notebook-share-tokens') || '{}');
      shareTokens[token] = metadata;
      localStorage.setItem('notebook-share-tokens', JSON.stringify(shareTokens));
    }
  };

  /**
   * Copy the generated share link to clipboard.
   */
  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(generatedLink);
      // TODO: Show a success notification
      console.log('Link copied to clipboard');
    } catch (err) {
      setError(trans.__('Failed to copy link to clipboard'));
      console.error('Error copying to clipboard:', err);
    }
  };

  /**
   * Get role display name for translation.
   */
  const getRoleDisplayName = (role: IPermissionsManager.Role): string => {
    switch (role) {
      case 'viewer':
        return trans.__('Viewer');
      case 'editor':
        return trans.__('Editor');
      case 'collaborator':
        return trans.__('Collaborator');
      case 'admin':
        return trans.__('Admin');
      default:
        return role;
    }
  };

  /**
   * Get role description for UI display.
   */
  const getRoleDescription = (role: IPermissionsManager.Role): string => {
    switch (role) {
      case 'viewer':
        return trans.__('Can view notebook content');
      case 'editor':
        return trans.__('Can view and edit notebook content');
      case 'collaborator':
        return trans.__('Can use all collaboration features');
      case 'admin':
        return trans.__('Has administrative access');
      default:
        return '';
    }
  };

  // Load users when component mounts
  useEffect(() => {
    loadUsers();
  }, []);

  // Subscribe to permission changes
  useEffect(() => {
    const handlePermissionChange = (event: IPermissionsManager.IPermissionEvent) => {
      // Reload users when permissions change
      loadUsers();
    };

    permissionsManager.onPermissionChange(handlePermissionChange);
    
    // Cleanup subscription
    return () => {
      // TODO: Implement unsubscribe mechanism in permissions manager
    };
  }, [permissionsManager]);

  if (loading) {
    return (
      <div className={PERMISSIONS_DIALOG_CLASS}>
        <div className="jp-PermissionsDialog-loading">
          {trans.__('Loading permissions...')}
        </div>
      </div>
    );
  }

  return (
    <div className={PERMISSIONS_DIALOG_CLASS}>
      <div className="jp-PermissionsDialog-header">
        <h2>{trans.__('Manage Permissions')}</h2>
        <p>{trans.__('Control who can access and edit this notebook')}</p>
      </div>

      {error && (
        <div className="jp-PermissionsDialog-error">
          <span className="jp-PermissionsDialog-errorIcon">⚠️</span>
          {error}
        </div>
      )}

      {/* Current Users Section */}
      <div className="jp-PermissionsDialog-section">
        <h3>{trans.__('Current Users')}</h3>
        <div className={USER_LIST_CLASS}>
          {users.map(user => (
            <div key={user.userId} className={USER_ITEM_CLASS}>
              <div className="jp-PermissionsDialog-userInfo">
                {user.avatar && (
                  <img
                    src={user.avatar}
                    alt={user.name}
                    className="jp-PermissionsDialog-avatar"
                  />
                )}
                <div className="jp-PermissionsDialog-userDetails">
                  <div className="jp-PermissionsDialog-userName">
                    {user.name}
                    {user.isCurrentUser && (
                      <span className="jp-PermissionsDialog-currentUserBadge">
                        {trans.__('(You)')}
                      </span>
                    )}
                  </div>
                  {user.email && (
                    <div className="jp-PermissionsDialog-userEmail">
                      {user.email}
                    </div>
                  )}
                </div>
              </div>
              
              <div className="jp-PermissionsDialog-userControls">
                <select
                  className={ROLE_SELECT_CLASS}
                  value={user.role}
                  onChange={(e) => handleRoleChange(user.userId, e.target.value as IPermissionsManager.Role)}
                  disabled={user.isCurrentUser}
                  title={user.isCurrentUser ? trans.__('Cannot change your own role') : getRoleDescription(user.role)}
                  aria-label={trans.__('Role for %1', user.name)}
                >
                  <option value="viewer">{getRoleDisplayName('viewer')}</option>
                  <option value="editor">{getRoleDisplayName('editor')}</option>
                  <option value="collaborator">{getRoleDisplayName('collaborator')}</option>
                  <option value="admin">{getRoleDisplayName('admin')}</option>
                </select>
                
                {!user.isCurrentUser && (
                  <button
                    className={`${BUTTON_CLASS} jp-PermissionsDialog-removeButton`}
                    onClick={() => handleRemoveUser(user.userId)}
                    title={trans.__('Remove user')}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
          
          {users.length === 0 && (
            <div className="jp-PermissionsDialog-emptyState">
              {trans.__('No users have access to this notebook yet')}
            </div>
          )}
        </div>
      </div>

      {/* Add User Section */}
      <div className="jp-PermissionsDialog-section">
        <h3>{trans.__('Add User')}</h3>
        <div className={ADD_USER_SECTION_CLASS}>
          <div className="jp-PermissionsDialog-addUserForm">
            <input
              type="text"
              className={INPUT_CLASS}
              placeholder={trans.__('Enter email address or username')}
              value={newUserEmail}
              onChange={(e) => setNewUserEmail(e.target.value)}
              disabled={addingUser}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && !addingUser && newUserEmail.trim()) {
                  handleAddUser();
                }
              }}
              aria-label={trans.__('User email or username')}
              aria-describedby="add-user-help"
            />
            <div id="add-user-help" className="jp-PermissionsDialog-inputHelp">
              {trans.__('Enter an email address or username to grant access')}
            </div>
            
            <select
              className={ROLE_SELECT_CLASS}
              value={newUserRole}
              onChange={(e) => setNewUserRole(e.target.value as IPermissionsManager.Role)}
              disabled={addingUser}
            >
              <option value="viewer">{getRoleDisplayName('viewer')}</option>
              <option value="editor">{getRoleDisplayName('editor')}</option>
              <option value="collaborator">{getRoleDisplayName('collaborator')}</option>
              <option value="admin">{getRoleDisplayName('admin')}</option>
            </select>
            
            <button
              className={`${BUTTON_CLASS} jp-PermissionsDialog-addButton`}
              onClick={handleAddUser}
              disabled={addingUser || !newUserEmail.trim()}
            >
              {addingUser ? trans.__('Adding...') : trans.__('Add User')}
            </button>
          </div>
        </div>
      </div>

      {/* Share Link Section */}
      <div className="jp-PermissionsDialog-section">
        <h3>{trans.__('Share with Link')}</h3>
        <div className={SHARE_SECTION_CLASS}>
          <div className="jp-PermissionsDialog-presetSelection">
            <label>{trans.__('Permission Level:')}</label>
            <select
              className={ROLE_SELECT_CLASS}
              value={selectedPreset.name}
              onChange={(e) => {
                const preset = SHARE_PRESETS.find(p => p.name === e.target.value);
                if (preset) setSelectedPreset(preset);
              }}
            >
              {SHARE_PRESETS.map(preset => (
                <option key={preset.name} value={preset.name}>
                  {preset.name}
                </option>
              ))}
            </select>
            <div className="jp-PermissionsDialog-presetDescription">
              {selectedPreset.description}
            </div>
          </div>
          
          <button
            className={`${BUTTON_CLASS} jp-PermissionsDialog-generateButton`}
            onClick={handleGenerateShareLink}
            disabled={shareLoading}
          >
            {shareLoading ? trans.__('Generating...') : trans.__('Generate Share Link')}
          </button>
          
          {generatedLink && (
            <div className="jp-PermissionsDialog-generatedLink">
              <div className="jp-PermissionsDialog-linkContainer">
                <input
                  type="text"
                  className={`${INPUT_CLASS} jp-PermissionsDialog-linkInput`}
                  value={generatedLink}
                  readOnly
                />
                <button
                  className={`${BUTTON_CLASS} jp-PermissionsDialog-copyButton`}
                  onClick={handleCopyLink}
                  title={trans.__('Copy to clipboard')}
                >
                  📋
                </button>
              </div>
              <div className="jp-PermissionsDialog-linkNote">
                {trans.__('Anyone with this link will have %1 access to the notebook', selectedPreset.name)}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Namespace for PermissionsDialog static methods.
 */
/* CSS Styles for Permissions Dialog */
const permissionsDialogStyles = `
.jp-PermissionsDialog {
  min-width: 600px;
  max-width: 800px;
  padding: 16px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  font-family: var(--jp-ui-font-family);
  font-size: var(--jp-ui-font-size1);
  line-height: var(--jp-content-line-height);
}

.jp-PermissionsDialog-header {
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--jp-border-color2);
}

.jp-PermissionsDialog-header h2 {
  margin: 0 0 8px 0;
  font-size: var(--jp-ui-font-size3);
  font-weight: 600;
  color: var(--jp-ui-font-color1);
}

.jp-PermissionsDialog-header p {
  margin: 0;
  color: var(--jp-ui-font-color2);
  font-size: var(--jp-ui-font-size1);
}

.jp-PermissionsDialog-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  color: var(--jp-ui-font-color2);
}

.jp-PermissionsDialog-error {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  margin-bottom: 16px;
  background: var(--jp-error-color3);
  border: 1px solid var(--jp-error-color1);
  border-radius: 4px;
  color: var(--jp-error-color1);
  font-size: var(--jp-ui-font-size1);
}

.jp-PermissionsDialog-errorIcon {
  margin-right: 8px;
  font-size: 16px;
}

.jp-PermissionsDialog-section {
  margin-bottom: 32px;
}

.jp-PermissionsDialog-section h3 {
  margin: 0 0 16px 0;
  font-size: var(--jp-ui-font-size2);
  font-weight: 500;
  color: var(--jp-ui-font-color1);
}

.jp-PermissionsDialog-userList {
  border: 1px solid var(--jp-border-color2);
  border-radius: 4px;
  background: var(--jp-layout-color0);
}

.jp-PermissionsDialog-userItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--jp-border-color2);
}

.jp-PermissionsDialog-userItem:last-child {
  border-bottom: none;
}

.jp-PermissionsDialog-userInfo {
  display: flex;
  align-items: center;
  flex: 1;
}

.jp-PermissionsDialog-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  margin-right: 12px;
  object-fit: cover;
  border: 2px solid var(--jp-border-color2);
}

.jp-PermissionsDialog-userDetails {
  flex: 1;
}

.jp-PermissionsDialog-userName {
  font-weight: 500;
  color: var(--jp-ui-font-color1);
  display: flex;
  align-items: center;
  gap: 8px;
}

.jp-PermissionsDialog-currentUserBadge {
  font-size: var(--jp-ui-font-size0);
  color: var(--jp-ui-font-color2);
  font-weight: normal;
}

.jp-PermissionsDialog-userEmail {
  font-size: var(--jp-ui-font-size0);
  color: var(--jp-ui-font-color2);
  margin-top: 2px;
}

.jp-PermissionsDialog-userControls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.jp-PermissionsDialog-roleSelect {
  padding: 6px 12px;
  border: 1px solid var(--jp-border-color2);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  font-family: var(--jp-ui-font-family);
  font-size: var(--jp-ui-font-size1);
  cursor: pointer;
  min-width: 120px;
}

.jp-PermissionsDialog-roleSelect:focus {
  outline: 2px solid var(--jp-brand-color1);
  outline-offset: 2px;
}

.jp-PermissionsDialog-roleSelect:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.jp-PermissionsDialog-button {
  padding: 8px 16px;
  border: 1px solid var(--jp-border-color1);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  font-family: var(--jp-ui-font-family);
  font-size: var(--jp-ui-font-size1);
  cursor: pointer;
  transition: all 0.2s ease;
}

.jp-PermissionsDialog-button:hover:not(:disabled) {
  background: var(--jp-layout-color2);
  border-color: var(--jp-brand-color1);
}

.jp-PermissionsDialog-button:focus {
  outline: 2px solid var(--jp-brand-color1);
  outline-offset: 2px;
}

.jp-PermissionsDialog-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.jp-PermissionsDialog-removeButton {
  background: var(--jp-error-color3);
  border-color: var(--jp-error-color1);
  color: var(--jp-error-color1);
  padding: 6px 8px;
  min-width: auto;
}

.jp-PermissionsDialog-removeButton:hover:not(:disabled) {
  background: var(--jp-error-color2);
}

.jp-PermissionsDialog-addButton {
  background: var(--jp-brand-color1);
  border-color: var(--jp-brand-color1);
  color: var(--jp-ui-inverse-font-color1);
}

.jp-PermissionsDialog-addButton:hover:not(:disabled) {
  background: var(--jp-brand-color0);
  border-color: var(--jp-brand-color0);
}

.jp-PermissionsDialog-generateButton {
  background: var(--jp-accent-color1);
  border-color: var(--jp-accent-color1);
  color: var(--jp-ui-inverse-font-color1);
}

.jp-PermissionsDialog-generateButton:hover:not(:disabled) {
  background: var(--jp-accent-color0);
  border-color: var(--jp-accent-color0);
}

.jp-PermissionsDialog-copyButton {
  padding: 6px 12px;
  min-width: auto;
}

.jp-PermissionsDialog-input {
  padding: 8px 12px;
  border: 1px solid var(--jp-border-color2);
  border-radius: 4px;
  background: var(--jp-layout-color1);
  color: var(--jp-ui-font-color1);
  font-family: var(--jp-ui-font-family);
  font-size: var(--jp-ui-font-size1);
  flex: 1;
}

.jp-PermissionsDialog-input:focus {
  outline: 2px solid var(--jp-brand-color1);
  outline-offset: 2px;
}

.jp-PermissionsDialog-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.jp-PermissionsDialog-addUserForm {
  display: flex;
  gap: 12px;
  align-items: center;
}

.jp-PermissionsDialog-presetSelection {
  margin-bottom: 16px;
}

.jp-PermissionsDialog-presetSelection label {
  display: block;
  margin-bottom: 8px;
  font-weight: 500;
  color: var(--jp-ui-font-color1);
}

.jp-PermissionsDialog-presetDescription {
  margin-top: 8px;
  font-size: var(--jp-ui-font-size0);
  color: var(--jp-ui-font-color2);
  font-style: italic;
}

.jp-PermissionsDialog-generatedLink {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--jp-border-color2);
  border-radius: 4px;
  background: var(--jp-layout-color0);
}

.jp-PermissionsDialog-linkContainer {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.jp-PermissionsDialog-linkInput {
  font-family: var(--jp-code-font-family);
  font-size: var(--jp-code-font-size);
  background: var(--jp-layout-color2);
}

.jp-PermissionsDialog-linkNote {
  font-size: var(--jp-ui-font-size0);
  color: var(--jp-ui-font-color2);
}

.jp-PermissionsDialog-emptyState {
  padding: 24px;
  text-align: center;
  color: var(--jp-ui-font-color2);
  font-style: italic;
}

.jp-PermissionsDialog-inputHelp {
  font-size: var(--jp-ui-font-size0);
  color: var(--jp-ui-font-color2);
  margin-top: 4px;
  line-height: 1.4;
}

/* Responsive design for smaller screens */
@media (max-width: 768px) {
  .jp-PermissionsDialog {
    min-width: 90vw;
    max-width: 90vw;
    padding: 12px;
  }

  .jp-PermissionsDialog-userItem {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .jp-PermissionsDialog-userControls {
    width: 100%;
    justify-content: flex-end;
  }

  .jp-PermissionsDialog-addUserForm {
    flex-direction: column;
    align-items: stretch;
  }

  .jp-PermissionsDialog-linkContainer {
    flex-direction: column;
  }
}
`;

/**
 * Inject CSS styles into the document head.
 */
const injectStyles = () => {
  const styleId = 'jp-permissions-dialog-styles';
  if (!document.getElementById(styleId)) {
    const styleElement = document.createElement('style');
    styleElement.id = styleId;
    styleElement.textContent = permissionsDialogStyles;
    document.head.appendChild(styleElement);
  }
};

export namespace PermissionsDialog {
  /**
   * Show the permissions dialog as a modal.
   */
  export const showModal = async (options: {
    permissionsManager: IPermissionsManager;
    accessControlList: IAccessControlList;
    yjsProvider: IYjsNotebookProvider;
    translator: ITranslator;
    notebookPath: string;
  }): Promise<void> => {
    const { permissionsManager, accessControlList, yjsProvider, translator, notebookPath } = options;
    const trans = translator.load('notebook');

    // Inject CSS styles
    injectStyles();

    const body = ReactWidget.create(
      <PermissionsDialogContent
        permissionsManager={permissionsManager}
        accessControlList={accessControlList}
        yjsProvider={yjsProvider}
        translator={translator}
        notebookPath={notebookPath}
      />
    );

    const result = await showDialog({
      title: trans.__('Notebook Permissions'),
      body,
      buttons: [
        {
          label: trans.__('Close'),
          caption: trans.__('Close the permissions dialog'),
          className: 'jp-Dialog-button jp-mod-accept',
          accept: true
        }
      ],
      defaultButton: 0,
      hasClose: true
    });

    return result.button.accept ? Promise.resolve() : Promise.reject();
  };

  /**
   * Create a new PermissionsDialog widget for embedding in panels.
   */
  export const create = (options: {
    permissionsManager: IPermissionsManager;
    accessControlList: IAccessControlList;
    yjsProvider: IYjsNotebookProvider;
    translator: ITranslator;
    notebookPath: string;
  }): ReactWidget => {
    const { permissionsManager, accessControlList, yjsProvider, translator, notebookPath } = options;

    // Inject CSS styles
    injectStyles();

    return ReactWidget.create(
      <PermissionsDialogContent
        permissionsManager={permissionsManager}
        accessControlList={accessControlList}
        yjsProvider={yjsProvider}
        translator={translator}
        notebookPath={notebookPath}
      />
    );
  };
}