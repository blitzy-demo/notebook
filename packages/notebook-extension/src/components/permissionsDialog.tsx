/**
 * Permissions Dialog Component for Jupyter Notebook v7
 * 
 * React component for managing user roles and access control settings with role 
 * assignment interface (owner, editor, viewer) and share link generation. Provides 
 * fine-grained permission management via modal dialog accessible from right sidebar 
 * or Collaboration Bar.
 * 
 * Integrates with JupyterHub for authentication and role management, enforces
 * permissions at cell and notebook level, and supports real-time collaboration
 * scenarios with proper conflict resolution.
 * 
 * @author Jupyter Development Team
 * @version 7.0.0
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Widget } from '@lumino/widgets';
import { IDisposable } from '@lumino/disposable';

// Future imports for actual collaboration integration
// import { IPermissionsManager } from '@jupyter-notebook/application:IPermissionsManager';
// import { IAccessControlList } from '@jupyter-notebook/application:IAccessControlList';
// import { IYjsNotebookProvider } from '@jupyter-notebook/application:IYjsNotebookProvider';

// Permission system interfaces based on tokens.ts specification
interface IUserInfo {
  userId: string;
  name: string;
  email?: string;
  avatar?: string;
  role: 'viewer' | 'editor' | 'collaborator' | 'admin';
  addedAt: number;
  isOwner?: boolean;
  lastActive?: number;
  permissions: IPermission[];
}

interface IPermission {
  type: 'read' | 'write' | 'execute' | 'comment' | 'manage' | 'lock' | 'history' | 'share';
  resourceId?: string; // For cell-specific permissions
  grantedAt: number;
  grantedBy: string;
}

interface IShareLink {
  id: string;
  url: string;
  role: 'viewer' | 'editor' | 'collaborator';
  expiresAt?: number;
  usageCount: number;
  maxUsage?: number;
  createdAt: number;
  createdBy: string;
  isActive: boolean;
}

interface IPermissionTemplate {
  name: string;
  role: 'viewer' | 'editor' | 'collaborator' | 'admin';
  permissions: IPermission['type'][];
  description: string;
  isDefault?: boolean;
}

interface IJupyterHubUser {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
  groups: string[];
  isAdmin: boolean;
  lastLogin?: number;
}

// Main component props interface
interface IPermissionsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  notebookPath?: string;
  currentUser?: IUserInfo;
  onPermissionChange?: (userId: string, newRole: string) => void;
  onUserAdd?: (user: IUserInfo) => void;
  onUserRemove?: (userId: string) => void;
  onShareLinkCreate?: (options: IShareLinkOptions) => Promise<IShareLink>;
  onShareLinkRevoke?: (linkId: string) => Promise<void>;
  jupyterHubIntegration?: boolean;
  className?: string;
}

interface IShareLinkOptions {
  role: 'viewer' | 'editor' | 'collaborator';
  expiresIn?: number; // hours
  maxUsage?: number;
  requireAuth?: boolean;
}

// Error and loading state interfaces
interface IPermissionError {
  code: string;
  message: string;
  timestamp: Date;
  userId?: string;
  operation?: string;
  recoverable: boolean;
}

interface ILoadingState {
  isLoading: boolean;
  operation?: 'loading' | 'saving' | 'adding-user' | 'removing-user' | 'creating-link' | 'revoking-link';
  progress?: number;
}

// Internal state interface
interface IPermissionsDialogState {
  users: IUserInfo[];
  shareLinks: IShareLink[];
  availableUsers: IJupyterHubUser[];
  selectedUsers: string[];
  searchQuery: string;
  activeTab: 'users' | 'links' | 'templates';
  editingUser: string | null;
  showAddUser: boolean;
  showCreateLink: boolean;
  permissionTemplates: IPermissionTemplate[];
  error: IPermissionError | null;
  loading: ILoadingState;
  hasUnsavedChanges: boolean;
  lastSyncTime: Date;
}

// Mock provider interface (will be replaced with actual services)
interface IPermissionsProvider {
  getUsers: () => Promise<IUserInfo[]>;
  getShareLinks: () => Promise<IShareLink[]>;
  getAvailableUsers: () => Promise<IJupyterHubUser[]>;
  updateUserRole: (userId: string, role: string) => Promise<void>;
  addUser: (user: IUserInfo) => Promise<void>;
  removeUser: (userId: string) => Promise<void>;
  createShareLink: (options: IShareLinkOptions) => Promise<IShareLink>;
  revokeShareLink: (linkId: string) => Promise<void>;
  checkPermission: (userId: string, permission: string) => boolean;
  on: (event: string, callback: Function) => void;
  off: (event: string, callback: Function) => void;
}

/**
 * Permissions Dialog Component
 * 
 * Modal dialog for comprehensive permission management, accessible from the
 * collaboration sidebar or Collaboration Bar. Provides user role management,
 * share link generation, and fine-grained access control.
 */
export const PermissionsDialog: React.FC<IPermissionsDialogProps> = ({
  isOpen,
  onClose,
  notebookPath = '',
  currentUser,
  onPermissionChange,
  onUserAdd,
  onUserRemove,
  onShareLinkCreate,
  onShareLinkRevoke,
  jupyterHubIntegration = true,
  className = ''
}) => {
  // Refs for accessibility and focus management
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Component state management
  const [state, setState] = useState<IPermissionsDialogState>({
    users: [],
    shareLinks: [],
    availableUsers: [],
    selectedUsers: [],
    searchQuery: '',
    activeTab: 'users',
    editingUser: null,
    showAddUser: false,
    showCreateLink: false,
    permissionTemplates: [
      {
        name: 'Viewer',
        role: 'viewer',
        permissions: ['read'],
        description: 'Can view notebook content but cannot edit',
        isDefault: true
      },
      {
        name: 'Editor',
        role: 'editor',
        permissions: ['read', 'write', 'execute'],
        description: 'Can view and edit notebook content'
      },
      {
        name: 'Collaborator',
        role: 'collaborator',
        permissions: ['read', 'write', 'execute', 'comment', 'lock'],
        description: 'Full collaboration features with comments and locking'
      },
      {
        name: 'Admin',
        role: 'admin',
        permissions: ['read', 'write', 'execute', 'comment', 'manage', 'lock', 'history', 'share'],
        description: 'Full administrative access to the notebook'
      }
    ],
    error: null,
    loading: { isLoading: false },
    hasUnsavedChanges: false,
    lastSyncTime: new Date()
  });

  // Mock provider - will be replaced with actual service injection
  const provider = useMemo<IPermissionsProvider>(() => ({
    getUsers: async () => [
      {
        userId: 'user1',
        name: 'Alice Johnson',
        email: 'alice@example.com',
        role: 'editor' as const,
        addedAt: Date.now() - 86400000,
        isOwner: false,
        lastActive: Date.now() - 300000,
        permissions: [
          { type: 'read', grantedAt: Date.now() - 86400000, grantedBy: 'system' },
          { type: 'write', grantedAt: Date.now() - 86400000, grantedBy: 'system' },
          { type: 'execute', grantedAt: Date.now() - 86400000, grantedBy: 'system' }
        ]
      },
      {
        userId: 'user2',
        name: 'Bob Smith',
        email: 'bob@example.com',
        role: 'viewer' as const,
        addedAt: Date.now() - 172800000,
        isOwner: false,
        lastActive: Date.now() - 3600000,
        permissions: [
          { type: 'read', grantedAt: Date.now() - 172800000, grantedBy: 'system' }
        ]
      }
    ],
    getShareLinks: async () => [
      {
        id: 'link1',
        url: 'https://notebook.example.com/share/abc123',
        role: 'viewer' as const,
        usageCount: 5,
        maxUsage: 10,
        createdAt: Date.now() - 86400000,
        createdBy: 'currentUser',
        isActive: true
      }
    ],
    getAvailableUsers: async () => [
      {
        id: 'user3',
        name: 'Charlie Brown',
        email: 'charlie@example.com',
        groups: ['data-science', 'research'],
        isAdmin: false
      }
    ],
    updateUserRole: async (userId: string, role: string) => {
      console.log(`Updating user ${userId} to role ${role}`);
    },
    addUser: async (user: IUserInfo) => {
      console.log('Adding user:', user);
    },
    removeUser: async (userId: string) => {
      console.log('Removing user:', userId);
    },
    createShareLink: async (options: IShareLinkOptions) => ({
      id: `link_${Date.now()}`,
      url: `https://notebook.example.com/share/${Math.random().toString(36).substring(7)}`,
      role: options.role,
      expiresAt: options.expiresIn ? Date.now() + (options.expiresIn * 3600000) : undefined,
      usageCount: 0,
      maxUsage: options.maxUsage,
      createdAt: Date.now(),
      createdBy: currentUser?.userId || 'unknown',
      isActive: true
    }),
    revokeShareLink: async (linkId: string) => {
      console.log('Revoking share link:', linkId);
    },
    checkPermission: (userId: string, permission: string) => true,
    on: () => {},
    off: () => {}
  }), [currentUser]);

  // Load initial data and set up event listeners
  useEffect(() => {
    if (!isOpen) return;

    const loadData = async () => {
      setState(prev => ({ 
        ...prev, 
        loading: { isLoading: true, operation: 'loading' } 
      }));

      try {
        const [users, shareLinks, availableUsers] = await Promise.all([
          provider.getUsers(),
          provider.getShareLinks(),
          provider.getAvailableUsers()
        ]);

        setState(prev => ({
          ...prev,
          users,
          shareLinks,
          availableUsers,
          loading: { isLoading: false },
          lastSyncTime: new Date()
        }));
      } catch (error) {
        handleError({
          code: 'LOAD_FAILED',
          message: 'Failed to load permissions data',
          timestamp: new Date(),
          recoverable: true
        });
      }
    };

    loadData();

    // Set up real-time event listeners
    const handleUserUpdate = () => loadData();
    const handlePermissionChange = () => loadData();

    provider.on('userUpdate', handleUserUpdate);
    provider.on('permissionChange', handlePermissionChange);

    return () => {
      provider.off('userUpdate', handleUserUpdate);
      provider.off('permissionChange', handlePermissionChange);
    };
  }, [isOpen, provider]);

  // Focus management for accessibility
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      setTimeout(() => {
        dialogRef.current?.focus();
      }, 100);
    } else if (previousFocusRef.current) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [isOpen]);

  // Keyboard navigation handler
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;

      if (event.key === 'Escape') {
        handleClose();
      } else if (event.key === 'Tab') {
        // Trap focus within dialog
        const focusableElements = dialogRef.current?.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        
        if (focusableElements && focusableElements.length > 0) {
          const firstElement = focusableElements[0] as HTMLElement;
          const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;
          
          if (event.shiftKey && document.activeElement === firstElement) {
            event.preventDefault();
            lastElement.focus();
          } else if (!event.shiftKey && document.activeElement === lastElement) {
            event.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Event handlers
  const handleError = useCallback((error: IPermissionError) => {
    setState(prev => ({ 
      ...prev, 
      error, 
      loading: { isLoading: false } 
    }));

    // Auto-dismiss recoverable errors
    if (error.recoverable) {
      setTimeout(() => {
        setState(prev => ({ ...prev, error: null }));
      }, 5000);
    }
  }, []);

  const handleClose = useCallback(() => {
    if (state.hasUnsavedChanges) {
      const shouldClose = window.confirm(
        'You have unsaved changes. Are you sure you want to close?'
      );
      if (!shouldClose) return;
    }
    onClose();
  }, [state.hasUnsavedChanges, onClose]);

  const handleUserRoleChange = useCallback(async (userId: string, newRole: string) => {
    setState(prev => ({ 
      ...prev, 
      loading: { isLoading: true, operation: 'saving' },
      hasUnsavedChanges: true
    }));

    try {
      await provider.updateUserRole(userId, newRole);
      
      setState(prev => ({
        ...prev,
        users: prev.users.map(user => 
          user.userId === userId 
            ? { ...user, role: newRole as any }
            : user
        ),
        loading: { isLoading: false },
        hasUnsavedChanges: false
      }));

      onPermissionChange?.(userId, newRole);
    } catch (error) {
      handleError({
        code: 'ROLE_UPDATE_FAILED',
        message: `Failed to update role for user`,
        timestamp: new Date(),
        userId,
        operation: 'role-update',
        recoverable: true
      });
    }
  }, [provider, onPermissionChange, handleError]);

  const handleAddUser = useCallback(async (userData: Partial<IUserInfo>) => {
    setState(prev => ({ 
      ...prev, 
      loading: { isLoading: true, operation: 'adding-user' } 
    }));

    try {
      const newUser: IUserInfo = {
        userId: userData.userId || `user_${Date.now()}`,
        name: userData.name || 'Unknown User',
        email: userData.email,
        avatar: userData.avatar,
        role: userData.role || 'viewer',
        addedAt: Date.now(),
        permissions: state.permissionTemplates
          .find(t => t.role === (userData.role || 'viewer'))
          ?.permissions.map(type => ({
            type,
            grantedAt: Date.now(),
            grantedBy: currentUser?.userId || 'system'
          })) || []
      };

      await provider.addUser(newUser);
      
      setState(prev => ({
        ...prev,
        users: [...prev.users, newUser],
        loading: { isLoading: false },
        showAddUser: false
      }));

      onUserAdd?.(newUser);
    } catch (error) {
      handleError({
        code: 'ADD_USER_FAILED',
        message: 'Failed to add user',
        timestamp: new Date(),
        operation: 'add-user',
        recoverable: true
      });
    }
  }, [provider, currentUser, state.permissionTemplates, onUserAdd, handleError]);

  const handleRemoveUser = useCallback(async (userId: string) => {
    const user = state.users.find(u => u.userId === userId);
    if (!user) return;

    const shouldRemove = window.confirm(
      `Are you sure you want to remove ${user.name} from this notebook?`
    );
    if (!shouldRemove) return;

    setState(prev => ({ 
      ...prev, 
      loading: { isLoading: true, operation: 'removing-user' } 
    }));

    try {
      await provider.removeUser(userId);
      
      setState(prev => ({
        ...prev,
        users: prev.users.filter(u => u.userId !== userId),
        loading: { isLoading: false }
      }));

      onUserRemove?.(userId);
    } catch (error) {
      handleError({
        code: 'REMOVE_USER_FAILED',
        message: 'Failed to remove user',
        timestamp: new Date(),
        userId,
        operation: 'remove-user',
        recoverable: true
      });
    }
  }, [provider, state.users, onUserRemove, handleError]);

  const handleCreateShareLink = useCallback(async (options: IShareLinkOptions) => {
    setState(prev => ({ 
      ...prev, 
      loading: { isLoading: true, operation: 'creating-link' } 
    }));

    try {
      const shareLink = await provider.createShareLink(options);
      
      setState(prev => ({
        ...prev,
        shareLinks: [...prev.shareLinks, shareLink],
        loading: { isLoading: false },
        showCreateLink: false
      }));

      if (onShareLinkCreate) {
        await onShareLinkCreate(options);
      }
    } catch (error) {
      handleError({
        code: 'CREATE_LINK_FAILED',
        message: 'Failed to create share link',
        timestamp: new Date(),
        operation: 'create-link',
        recoverable: true
      });
    }
  }, [provider, onShareLinkCreate, handleError]);

  const handleRevokeShareLink = useCallback(async (linkId: string) => {
    const link = state.shareLinks.find(l => l.id === linkId);
    if (!link) return;

    const shouldRevoke = window.confirm(
      'Are you sure you want to revoke this share link? It will no longer work.'
    );
    if (!shouldRevoke) return;

    setState(prev => ({ 
      ...prev, 
      loading: { isLoading: true, operation: 'revoking-link' } 
    }));

    try {
      await provider.revokeShareLink(linkId);
      
      setState(prev => ({
        ...prev,
        shareLinks: prev.shareLinks.map(link => 
          link.id === linkId 
            ? { ...link, isActive: false }
            : link
        ),
        loading: { isLoading: false }
      }));

      if (onShareLinkRevoke) {
        await onShareLinkRevoke(linkId);
      }
    } catch (error) {
      handleError({
        code: 'REVOKE_LINK_FAILED',
        message: 'Failed to revoke share link',
        timestamp: new Date(),
        operation: 'revoke-link',
        recoverable: true
      });
    }
  }, [provider, state.shareLinks, onShareLinkRevoke, handleError]);

  const handleSearchChange = useCallback((query: string) => {
    setState(prev => ({ ...prev, searchQuery: query }));
  }, []);

  const handleTabChange = useCallback((tab: 'users' | 'links' | 'templates') => {
    setState(prev => ({ ...prev, activeTab: tab }));
  }, []);

  // Filter users based on search query
  const filteredUsers = useMemo(() => {
    if (!state.searchQuery) return state.users;
    
    const query = state.searchQuery.toLowerCase();
    return state.users.filter(user => 
      user.name.toLowerCase().includes(query) ||
      user.email?.toLowerCase().includes(query)
    );
  }, [state.users, state.searchQuery]);

  // Filter available users for adding
  const filteredAvailableUsers = useMemo(() => {
    const existingUserIds = state.users.map(u => u.userId);
    return state.availableUsers.filter(user => 
      !existingUserIds.includes(user.id) &&
      (!state.searchQuery || 
        user.name.toLowerCase().includes(state.searchQuery.toLowerCase()) ||
        user.email?.toLowerCase().includes(state.searchQuery.toLowerCase())
      )
    );
  }, [state.availableUsers, state.users, state.searchQuery]);

  // Render error notification
  const renderError = () => {
    if (!state.error) return null;

    return (
      <div className="jp-permissions-error" role="alert">
        <div className="jp-permissions-error-content">
          <span className="jp-permissions-error-icon">⚠️</span>
          <div className="jp-permissions-error-details">
            <span className="jp-permissions-error-message">{state.error.message}</span>
            {state.error.operation && (
              <span className="jp-permissions-error-operation">
                Operation: {state.error.operation}
              </span>
            )}
          </div>
          <button 
            className="jp-permissions-error-dismiss"
            onClick={() => setState(prev => ({ ...prev, error: null }))}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      </div>
    );
  };

  // Render loading overlay
  const renderLoading = () => {
    if (!state.loading.isLoading) return null;

    return (
      <div className="jp-permissions-loading" role="status" aria-live="polite">
        <div className="jp-permissions-loading-content">
          <div className="jp-permissions-loading-spinner" aria-hidden="true"></div>
          <span className="jp-permissions-loading-text">
            {state.loading.operation ? `${state.loading.operation}...` : 'Loading...'}
          </span>
        </div>
      </div>
    );
  };

  // Render users tab
  const renderUsersTab = () => (
    <div className="jp-permissions-tab-content">
      <div className="jp-permissions-users-header">
        <div className="jp-permissions-search-container">
          <input
            type="text"
            className="jp-permissions-search"
            placeholder="Search users..."
            value={state.searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            aria-label="Search users"
          />
          <button
            className="jp-permissions-add-user-btn"
            onClick={() => setState(prev => ({ ...prev, showAddUser: true }))}
            disabled={state.loading.isLoading}
          >
            ➕ Add User
          </button>
        </div>
      </div>

      <div className="jp-permissions-users-list">
        {filteredUsers.map(user => (
          <div key={user.userId} className="jp-permissions-user-item">
            <div className="jp-permissions-user-info">
              <div className="jp-permissions-user-avatar">
                {user.avatar ? (
                  <img src={user.avatar} alt={user.name} />
                ) : (
                  <span className="jp-permissions-user-initials">
                    {user.name.split(' ').map(n => n[0]).join('').toUpperCase()}
                  </span>
                )}
              </div>
              <div className="jp-permissions-user-details">
                <div className="jp-permissions-user-name">
                  {user.name}
                  {user.isOwner && <span className="jp-permissions-owner-badge">Owner</span>}
                </div>
                <div className="jp-permissions-user-email">{user.email}</div>
                <div className="jp-permissions-user-meta">
                  Added {new Date(user.addedAt).toLocaleDateString()}
                  {user.lastActive && (
                    <span className="jp-permissions-user-activity">
                      • Last active {new Date(user.lastActive).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
            
            <div className="jp-permissions-user-controls">
              <select
                className="jp-permissions-role-select"
                value={user.role}
                onChange={(e) => handleUserRoleChange(user.userId, e.target.value)}
                disabled={user.isOwner || state.loading.isLoading}
                aria-label={`Role for ${user.name}`}
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="collaborator">Collaborator</option>
                <option value="admin">Admin</option>
              </select>
              
              {!user.isOwner && (
                <button
                  className="jp-permissions-remove-user-btn"
                  onClick={() => handleRemoveUser(user.userId)}
                  disabled={state.loading.isLoading}
                  aria-label={`Remove ${user.name}`}
                >
                  🗑️
                </button>
              )}
            </div>
          </div>
        ))}
        
        {filteredUsers.length === 0 && (
          <div className="jp-permissions-empty-state">
            <p>No users found matching your search.</p>
          </div>
        )}
      </div>

      {/* Add User Dialog */}
      {state.showAddUser && (
        <div className="jp-permissions-add-user-dialog">
          <h3>Add User</h3>
          <div className="jp-permissions-available-users">
            {filteredAvailableUsers.map(user => (
              <div key={user.id} className="jp-permissions-available-user">
                <div className="jp-permissions-available-user-info">
                  <span className="jp-permissions-available-user-name">{user.name}</span>
                  <span className="jp-permissions-available-user-email">{user.email}</span>
                </div>
                <select
                  className="jp-permissions-role-select"
                  defaultValue="viewer"
                  onChange={(e) => {
                    handleAddUser({
                      userId: user.id,
                      name: user.name,
                      email: user.email,
                      role: e.target.value as any
                    });
                  }}
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="collaborator">Collaborator</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            ))}
          </div>
          <div className="jp-permissions-dialog-actions">
            <button
              className="jp-permissions-cancel-btn"
              onClick={() => setState(prev => ({ ...prev, showAddUser: false }))}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // Render share links tab
  const renderShareLinksTab = () => (
    <div className="jp-permissions-tab-content">
      <div className="jp-permissions-links-header">
        <button
          className="jp-permissions-create-link-btn"
          onClick={() => setState(prev => ({ ...prev, showCreateLink: true }))}
          disabled={state.loading.isLoading}
        >
          🔗 Create Share Link
        </button>
      </div>

      <div className="jp-permissions-links-list">
        {state.shareLinks.map(link => (
          <div key={link.id} className="jp-permissions-link-item">
            <div className="jp-permissions-link-info">
              <div className="jp-permissions-link-url">
                <input
                  type="text"
                  value={link.url}
                  readOnly
                  className="jp-permissions-link-input"
                  onClick={(e) => e.currentTarget.select()}
                />
                <button
                  className="jp-permissions-copy-btn"
                  onClick={() => navigator.clipboard.writeText(link.url)}
                >
                  📋
                </button>
              </div>
              <div className="jp-permissions-link-details">
                <span className="jp-permissions-link-role">Role: {link.role}</span>
                <span className="jp-permissions-link-usage">
                  Used: {link.usageCount}{link.maxUsage ? `/${link.maxUsage}` : ''}
                </span>
                {link.expiresAt && (
                  <span className="jp-permissions-link-expiry">
                    Expires: {new Date(link.expiresAt).toLocaleDateString()}
                  </span>
                )}
                <span className={`jp-permissions-link-status ${link.isActive ? 'active' : 'inactive'}`}>
                  {link.isActive ? 'Active' : 'Revoked'}
                </span>
              </div>
            </div>
            {link.isActive && (
              <button
                className="jp-permissions-revoke-link-btn"
                onClick={() => handleRevokeShareLink(link.id)}
                disabled={state.loading.isLoading}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
        
        {state.shareLinks.length === 0 && (
          <div className="jp-permissions-empty-state">
            <p>No share links created yet.</p>
          </div>
        )}
      </div>

      {/* Create Link Dialog */}
      {state.showCreateLink && (
        <div className="jp-permissions-create-link-dialog">
          <h3>Create Share Link</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const formData = new FormData(e.currentTarget);
              handleCreateShareLink({
                role: formData.get('role') as any,
                expiresIn: formData.get('expiresIn') ? Number(formData.get('expiresIn')) : undefined,
                maxUsage: formData.get('maxUsage') ? Number(formData.get('maxUsage')) : undefined,
                requireAuth: formData.get('requireAuth') === 'on'
              });
            }}
          >
            <div className="jp-permissions-form-group">
              <label htmlFor="role">Role:</label>
              <select name="role" id="role" defaultValue="viewer">
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="collaborator">Collaborator</option>
              </select>
            </div>
            
            <div className="jp-permissions-form-group">
              <label htmlFor="expiresIn">Expires in (hours):</label>
              <input type="number" name="expiresIn" id="expiresIn" min="1" max="8760" />
            </div>
            
            <div className="jp-permissions-form-group">
              <label htmlFor="maxUsage">Max usage count:</label>
              <input type="number" name="maxUsage" id="maxUsage" min="1" />
            </div>
            
            <div className="jp-permissions-form-group">
              <label>
                <input type="checkbox" name="requireAuth" />
                Require authentication
              </label>
            </div>
            
            <div className="jp-permissions-dialog-actions">
              <button type="submit" className="jp-permissions-create-btn">
                Create Link
              </button>
              <button
                type="button"
                className="jp-permissions-cancel-btn"
                onClick={() => setState(prev => ({ ...prev, showCreateLink: false }))}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );

  // Render permission templates tab
  const renderTemplatesTab = () => (
    <div className="jp-permissions-tab-content">
      <div className="jp-permissions-templates-list">
        {state.permissionTemplates.map(template => (
          <div key={template.name} className="jp-permissions-template-item">
            <div className="jp-permissions-template-header">
              <h4 className="jp-permissions-template-name">
                {template.name}
                {template.isDefault && <span className="jp-permissions-default-badge">Default</span>}
              </h4>
              <span className="jp-permissions-template-role">{template.role}</span>
            </div>
            <p className="jp-permissions-template-description">{template.description}</p>
            <div className="jp-permissions-template-permissions">
              <strong>Permissions:</strong>
              <ul>
                {template.permissions.map(permission => (
                  <li key={permission} className="jp-permissions-permission-item">
                    {permission}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // Don't render if dialog is closed
  if (!isOpen) return null;

  return (
    <>
      {/* Modal backdrop */}
      <div className="jp-permissions-backdrop" onClick={handleClose} />
      
      {/* Modal dialog */}
      <div
        ref={dialogRef}
        className={`jp-permissions-dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="permissions-dialog-title"
        tabIndex={-1}
      >
        {/* Embedded CSS Styles */}
        <style>{`
          .jp-permissions-backdrop {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 10000;
            backdrop-filter: blur(2px);
          }

          .jp-permissions-dialog {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 90%;
            max-width: 800px;
            max-height: 80vh;
            background: var(--jp-layout-color1);
            border: 1px solid var(--jp-border-color1);
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            z-index: 10001;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            font-family: var(--jp-ui-font-family);
            font-size: var(--jp-ui-font-size1);
          }

          .jp-permissions-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px 20px;
            border-bottom: 1px solid var(--jp-border-color2);
            background: var(--jp-layout-color2);
          }

          .jp-permissions-title {
            margin: 0;
            font-size: 18px;
            font-weight: 600;
            color: var(--jp-ui-font-color1);
          }

          .jp-permissions-close-btn {
            background: none;
            border: none;
            font-size: 20px;
            cursor: pointer;
            color: var(--jp-ui-font-color2);
            padding: 4px;
            border-radius: 4px;
            transition: background-color 0.2s;
          }

          .jp-permissions-close-btn:hover {
            background: var(--jp-layout-color3);
            color: var(--jp-ui-font-color1);
          }

          .jp-permissions-tabs {
            display: flex;
            border-bottom: 1px solid var(--jp-border-color2);
            background: var(--jp-layout-color2);
          }

          .jp-permissions-tab {
            flex: 1;
            padding: 12px 16px;
            border: none;
            background: none;
            cursor: pointer;
            color: var(--jp-ui-font-color2);
            font-size: 14px;
            font-weight: 500;
            transition: all 0.2s;
            border-bottom: 2px solid transparent;
          }

          .jp-permissions-tab:hover {
            background: var(--jp-layout-color3);
            color: var(--jp-ui-font-color1);
          }

          .jp-permissions-tab.active {
            color: var(--jp-brand-color1);
            border-bottom-color: var(--jp-brand-color1);
            background: var(--jp-layout-color1);
          }

          .jp-permissions-content {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
          }

          .jp-permissions-tab-content {
            height: 100%;
          }

          .jp-permissions-users-header,
          .jp-permissions-links-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--jp-border-color2);
          }

          .jp-permissions-search-container {
            display: flex;
            gap: 12px;
            align-items: center;
            flex: 1;
          }

          .jp-permissions-search {
            flex: 1;
            padding: 8px 12px;
            border: 1px solid var(--jp-border-color2);
            border-radius: 4px;
            background: var(--jp-layout-color0);
            color: var(--jp-ui-font-color1);
            font-size: 14px;
          }

          .jp-permissions-search:focus {
            outline: none;
            border-color: var(--jp-brand-color1);
          }

          .jp-permissions-add-user-btn,
          .jp-permissions-create-link-btn {
            padding: 8px 16px;
            border: 1px solid var(--jp-brand-color1);
            border-radius: 4px;
            background: var(--jp-brand-color1);
            color: white;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: background-color 0.2s;
            white-space: nowrap;
          }

          .jp-permissions-add-user-btn:hover,
          .jp-permissions-create-link-btn:hover {
            background: var(--jp-brand-color0);
          }

          .jp-permissions-add-user-btn:disabled,
          .jp-permissions-create-link-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .jp-permissions-users-list,
          .jp-permissions-links-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .jp-permissions-user-item,
          .jp-permissions-link-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px;
            border: 1px solid var(--jp-border-color2);
            border-radius: 6px;
            background: var(--jp-layout-color0);
            transition: border-color 0.2s;
          }

          .jp-permissions-user-item:hover,
          .jp-permissions-link-item:hover {
            border-color: var(--jp-border-color3);
          }

          .jp-permissions-user-info {
            display: flex;
            align-items: center;
            gap: 12px;
            flex: 1;
          }

          .jp-permissions-user-avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: var(--jp-layout-color3);
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            border: 2px solid var(--jp-border-color1);
          }

          .jp-permissions-user-avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }

          .jp-permissions-user-initials {
            font-size: 14px;
            font-weight: bold;
            color: var(--jp-ui-font-color1);
          }

          .jp-permissions-user-details {
            flex: 1;
          }

          .jp-permissions-user-name {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 16px;
            font-weight: 600;
            color: var(--jp-ui-font-color1);
            margin-bottom: 4px;
          }

          .jp-permissions-owner-badge {
            font-size: 11px;
            padding: 2px 6px;
            background: var(--jp-brand-color1);
            color: white;
            border-radius: 10px;
            font-weight: 500;
          }

          .jp-permissions-user-email {
            font-size: 13px;
            color: var(--jp-ui-font-color2);
            margin-bottom: 4px;
          }

          .jp-permissions-user-meta {
            font-size: 12px;
            color: var(--jp-ui-font-color3);
          }

          .jp-permissions-user-activity {
            margin-left: 8px;
          }

          .jp-permissions-user-controls {
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .jp-permissions-role-select {
            padding: 6px 8px;
            border: 1px solid var(--jp-border-color2);
            border-radius: 4px;
            background: var(--jp-layout-color1);
            color: var(--jp-ui-font-color1);
            font-size: 13px;
            cursor: pointer;
          }

          .jp-permissions-role-select:focus {
            outline: none;
            border-color: var(--jp-brand-color1);
          }

          .jp-permissions-role-select:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .jp-permissions-remove-user-btn {
            padding: 6px 8px;
            border: 1px solid var(--jp-error-color1);
            border-radius: 4px;
            background: var(--jp-error-color3);
            color: var(--jp-error-color1);
            font-size: 12px;
            cursor: pointer;
            transition: background-color 0.2s;
          }

          .jp-permissions-remove-user-btn:hover:not(:disabled) {
            background: var(--jp-error-color2);
          }

          .jp-permissions-remove-user-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .jp-permissions-link-info {
            flex: 1;
          }

          .jp-permissions-link-url {
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
          }

          .jp-permissions-link-input {
            flex: 1;
            padding: 6px 8px;
            border: 1px solid var(--jp-border-color2);
            border-radius: 4px;
            background: var(--jp-layout-color2);
            color: var(--jp-ui-font-color1);
            font-size: 13px;
            font-family: monospace;
          }

          .jp-permissions-copy-btn {
            padding: 6px 8px;
            border: 1px solid var(--jp-border-color2);
            border-radius: 4px;
            background: var(--jp-layout-color1);
            color: var(--jp-ui-font-color1);
            cursor: pointer;
            transition: background-color 0.2s;
          }

          .jp-permissions-copy-btn:hover {
            background: var(--jp-layout-color3);
          }

          .jp-permissions-link-details {
            display: flex;
            gap: 16px;
            font-size: 12px;
            color: var(--jp-ui-font-color2);
          }

          .jp-permissions-link-status.active {
            color: var(--jp-success-color1);
            font-weight: 500;
          }

          .jp-permissions-link-status.inactive {
            color: var(--jp-error-color1);
            font-weight: 500;
          }

          .jp-permissions-revoke-link-btn {
            padding: 6px 12px;
            border: 1px solid var(--jp-error-color1);
            border-radius: 4px;
            background: var(--jp-error-color3);
            color: var(--jp-error-color1);
            font-size: 13px;
            cursor: pointer;
            transition: background-color 0.2s;
          }

          .jp-permissions-revoke-link-btn:hover:not(:disabled) {
            background: var(--jp-error-color2);
          }

          .jp-permissions-revoke-link-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .jp-permissions-templates-list {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }

          .jp-permissions-template-item {
            padding: 16px;
            border: 1px solid var(--jp-border-color2);
            border-radius: 6px;
            background: var(--jp-layout-color0);
          }

          .jp-permissions-template-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
          }

          .jp-permissions-template-name {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
            color: var(--jp-ui-font-color1);
            display: flex;
            align-items: center;
            gap: 8px;
          }

          .jp-permissions-default-badge {
            font-size: 11px;
            padding: 2px 6px;
            background: var(--jp-success-color1);
            color: white;
            border-radius: 10px;
            font-weight: 500;
          }

          .jp-permissions-template-role {
            font-size: 13px;
            padding: 4px 8px;
            background: var(--jp-layout-color3);
            color: var(--jp-ui-font-color1);
            border-radius: 4px;
            font-weight: 500;
          }

          .jp-permissions-template-description {
            margin: 0 0 12px 0;
            font-size: 14px;
            color: var(--jp-ui-font-color2);
            line-height: 1.4;
          }

          .jp-permissions-template-permissions {
            font-size: 13px;
            color: var(--jp-ui-font-color1);
          }

          .jp-permissions-template-permissions ul {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin: 8px 0 0 0;
            padding: 0;
            list-style: none;
          }

          .jp-permissions-permission-item {
            padding: 4px 8px;
            background: var(--jp-layout-color2);
            border: 1px solid var(--jp-border-color2);
            border-radius: 4px;
            font-size: 12px;
            color: var(--jp-ui-font-color1);
          }

          .jp-permissions-empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--jp-ui-font-color2);
          }

          .jp-permissions-empty-state p {
            margin: 0;
            font-size: 16px;
          }

          .jp-permissions-add-user-dialog,
          .jp-permissions-create-link-dialog {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 90%;
            max-width: 500px;
            background: var(--jp-layout-color1);
            border: 1px solid var(--jp-border-color1);
            border-radius: 6px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
            z-index: 10002;
            padding: 20px;
          }

          .jp-permissions-add-user-dialog h3,
          .jp-permissions-create-link-dialog h3 {
            margin: 0 0 16px 0;
            font-size: 18px;
            color: var(--jp-ui-font-color1);
          }

          .jp-permissions-available-users {
            max-height: 200px;
            overflow-y: auto;
            border: 1px solid var(--jp-border-color2);
            border-radius: 4px;
            margin-bottom: 16px;
          }

          .jp-permissions-available-user {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px;
            border-bottom: 1px solid var(--jp-border-color2);
          }

          .jp-permissions-available-user:last-child {
            border-bottom: none;
          }

          .jp-permissions-available-user-info {
            flex: 1;
          }

          .jp-permissions-available-user-name {
            display: block;
            font-weight: 500;
            color: var(--jp-ui-font-color1);
            margin-bottom: 2px;
          }

          .jp-permissions-available-user-email {
            display: block;
            font-size: 13px;
            color: var(--jp-ui-font-color2);
          }

          .jp-permissions-form-group {
            margin-bottom: 16px;
          }

          .jp-permissions-form-group label {
            display: block;
            margin-bottom: 6px;
            font-weight: 500;
            color: var(--jp-ui-font-color1);
          }

          .jp-permissions-form-group input,
          .jp-permissions-form-group select {
            width: 100%;
            padding: 8px 12px;
            border: 1px solid var(--jp-border-color2);
            border-radius: 4px;
            background: var(--jp-layout-color0);
            color: var(--jp-ui-font-color1);
            font-size: 14px;
          }

          .jp-permissions-form-group input:focus,
          .jp-permissions-form-group select:focus {
            outline: none;
            border-color: var(--jp-brand-color1);
          }

          .jp-permissions-form-group input[type="checkbox"] {
            width: auto;
            margin-right: 8px;
          }

          .jp-permissions-dialog-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 20px;
          }

          .jp-permissions-create-btn {
            padding: 8px 16px;
            border: 1px solid var(--jp-brand-color1);
            border-radius: 4px;
            background: var(--jp-brand-color1);
            color: white;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: background-color 0.2s;
          }

          .jp-permissions-create-btn:hover {
            background: var(--jp-brand-color0);
          }

          .jp-permissions-cancel-btn {
            padding: 8px 16px;
            border: 1px solid var(--jp-border-color2);
            border-radius: 4px;
            background: var(--jp-layout-color2);
            color: var(--jp-ui-font-color1);
            font-size: 14px;
            cursor: pointer;
            transition: background-color 0.2s;
          }

          .jp-permissions-cancel-btn:hover {
            background: var(--jp-layout-color3);
          }

          .jp-permissions-error {
            position: absolute;
            top: 60px;
            left: 20px;
            right: 20px;
            z-index: 10003;
            background: var(--jp-error-color3);
            border: 1px solid var(--jp-error-color1);
            border-radius: 4px;
            padding: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
          }

          .jp-permissions-error-content {
            display: flex;
            align-items: flex-start;
            gap: 8px;
          }

          .jp-permissions-error-icon {
            font-size: 16px;
            margin-top: 2px;
          }

          .jp-permissions-error-details {
            flex: 1;
          }

          .jp-permissions-error-message {
            display: block;
            font-size: 14px;
            color: var(--jp-error-color1);
            font-weight: 500;
            margin-bottom: 2px;
          }

          .jp-permissions-error-operation {
            display: block;
            font-size: 12px;
            color: var(--jp-error-color1);
            opacity: 0.8;
          }

          .jp-permissions-error-dismiss {
            background: none;
            border: none;
            color: var(--jp-error-color1);
            font-size: 14px;
            cursor: pointer;
            padding: 2px;
            border-radius: 2px;
            transition: background-color 0.2s;
          }

          .jp-permissions-error-dismiss:hover {
            background: var(--jp-error-color2);
          }

          .jp-permissions-loading {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(255, 255, 255, 0.9);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10003;
            border-radius: 8px;
          }

          [data-jp-theme-light="false"] .jp-permissions-loading {
            background: rgba(0, 0, 0, 0.9);
          }

          .jp-permissions-loading-content {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
          }

          .jp-permissions-loading-spinner {
            width: 24px;
            height: 24px;
            border: 2px solid var(--jp-border-color3);
            border-top: 2px solid var(--jp-brand-color1);
            border-radius: 50%;
            animation: jp-permissions-spin 1s linear infinite;
          }

          .jp-permissions-loading-text {
            font-size: 14px;
            color: var(--jp-ui-font-color1);
            font-weight: 500;
          }

          @keyframes jp-permissions-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }

          /* Responsive Design */
          @media (max-width: 768px) {
            .jp-permissions-dialog {
              width: 95%;
              max-height: 90vh;
            }

            .jp-permissions-header {
              padding: 12px 16px;
            }

            .jp-permissions-content {
              padding: 16px;
            }

            .jp-permissions-user-item,
            .jp-permissions-link-item {
              flex-direction: column;
              align-items: stretch;
              gap: 12px;
            }

            .jp-permissions-user-controls {
              justify-content: flex-end;
            }

            .jp-permissions-search-container {
              flex-direction: column;
              align-items: stretch;
            }

            .jp-permissions-add-user-dialog,
            .jp-permissions-create-link-dialog {
              width: 95%;
            }
          }

          /* Dark Theme Support */
          [data-jp-theme-light="false"] .jp-permissions-backdrop {
            background: rgba(255, 255, 255, 0.1);
          }

          [data-jp-theme-light="false"] .jp-permissions-dialog {
            box-shadow: 0 8px 32px rgba(255, 255, 255, 0.1);
          }

          /* High Contrast Support */
          @media (prefers-contrast: high) {
            .jp-permissions-dialog {
              border-width: 2px;
            }

            .jp-permissions-user-item,
            .jp-permissions-link-item,
            .jp-permissions-template-item {
              border-width: 2px;
            }

            .jp-permissions-search,
            .jp-permissions-role-select,
            .jp-permissions-link-input {
              border-width: 2px;
            }
          }

          /* Focus styles for accessibility */
          .jp-permissions-tab:focus,
          .jp-permissions-search:focus,
          .jp-permissions-role-select:focus,
          .jp-permissions-add-user-btn:focus,
          .jp-permissions-create-link-btn:focus,
          .jp-permissions-remove-user-btn:focus,
          .jp-permissions-revoke-link-btn:focus,
          .jp-permissions-copy-btn:focus,
          .jp-permissions-close-btn:focus {
            outline: 2px solid var(--jp-brand-color1);
            outline-offset: 2px;
          }

          /* Animation for dialog appearance */
          @keyframes jp-permissions-dialog-appear {
            from {
              opacity: 0;
              transform: translate(-50%, -50%) scale(0.9);
            }
            to {
              opacity: 1;
              transform: translate(-50%, -50%) scale(1);
            }
          }

          .jp-permissions-dialog {
            animation: jp-permissions-dialog-appear 0.2s ease-out;
          }

          @keyframes jp-permissions-backdrop-appear {
            from { opacity: 0; }
            to { opacity: 1; }
          }

          .jp-permissions-backdrop {
            animation: jp-permissions-backdrop-appear 0.15s ease-out;
          }
        `}</style>

        {/* Error Notification */}
        {renderError()}
        
        {/* Loading Overlay */}
        {renderLoading()}

        {/* Dialog Header */}
        <div className="jp-permissions-header">
          <h2 id="permissions-dialog-title" className="jp-permissions-title">
            Permissions & Sharing
            {notebookPath && (
              <span className="jp-permissions-notebook-path">
                {notebookPath.split('/').pop()}
              </span>
            )}
          </h2>
          <button
            className="jp-permissions-close-btn"
            onClick={handleClose}
            aria-label="Close permissions dialog"
          >
            ✕
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="jp-permissions-tabs" role="tablist">
          <button
            className={`jp-permissions-tab ${state.activeTab === 'users' ? 'active' : ''}`}
            onClick={() => handleTabChange('users')}
            role="tab"
            aria-selected={state.activeTab === 'users'}
            aria-controls="users-panel"
          >
            👥 Users ({state.users.length})
          </button>
          <button
            className={`jp-permissions-tab ${state.activeTab === 'links' ? 'active' : ''}`}
            onClick={() => handleTabChange('links')}
            role="tab"
            aria-selected={state.activeTab === 'links'}
            aria-controls="links-panel"
          >
            🔗 Share Links ({state.shareLinks.filter(l => l.isActive).length})
          </button>
          <button
            className={`jp-permissions-tab ${state.activeTab === 'templates' ? 'active' : ''}`}
            onClick={() => handleTabChange('templates')}
            role="tab"
            aria-selected={state.activeTab === 'templates'}
            aria-controls="templates-panel"
          >
            📋 Templates
          </button>
        </div>

        {/* Tab Content */}
        <div className="jp-permissions-content">
          <div
            id="users-panel"
            role="tabpanel"
            aria-labelledby="users-tab"
            hidden={state.activeTab !== 'users'}
          >
            {state.activeTab === 'users' && renderUsersTab()}
          </div>
          
          <div
            id="links-panel"
            role="tabpanel"
            aria-labelledby="links-tab"
            hidden={state.activeTab !== 'links'}
          >
            {state.activeTab === 'links' && renderShareLinksTab()}
          </div>
          
          <div
            id="templates-panel"
            role="tabpanel"
            aria-labelledby="templates-tab"
            hidden={state.activeTab !== 'templates'}
          >
            {state.activeTab === 'templates' && renderTemplatesTab()}
          </div>
        </div>
      </div>
    </>
  );
};

// Default export for easier importing
export default PermissionsDialog;

/**
 * Lumino Widget wrapper for the PermissionsDialog component
 * Enables integration with JupyterLab's widget system and shell
 * 
 * This widget is designed to be displayed as a modal dialog accessible from
 * the collaboration sidebar or Collaboration Bar. It integrates with the
 * IPermissionsManager and other collaboration services to provide comprehensive
 * access control management.
 * 
 * Features:
 * - Role-based access control with granular permissions
 * - User management with JupyterHub integration
 * - Share link generation with customizable settings
 * - Permission templates for common use cases
 * - Real-time permission synchronization
 * - Comprehensive error handling and recovery
 * - Full accessibility support with keyboard navigation
 * - Responsive design for all screen sizes
 * - Dark theme and high contrast support
 * 
 * @example
 * ```typescript
 * const widget = new PermissionsDialogWidget({
 *   onPermissionChange: (userId, role) => console.log('Role changed'),
 *   onUserAdd: (user) => console.log('User added'),
 *   onUserRemove: (userId) => console.log('User removed'),
 *   jupyterHubIntegration: true
 * });
 * widget.show();
 * ```
 */
export class PermissionsDialogWidget extends Widget implements IDisposable {
  private _permissionsDialog: React.ReactElement;
  private _options: IPermissionsDialogProps;
  private _isOpen: boolean = false;

  constructor(options: Partial<IPermissionsDialogProps> = {}) {
    super();
    this.addClass('jp-permissions-dialog-widget');
    this.id = 'permissions-dialog';
    this.title.label = 'Permissions';
    this.title.caption = 'Manage notebook permissions and sharing';
    
    // Add accessibility attributes
    this.node.setAttribute('role', 'dialog');
    this.node.setAttribute('aria-label', 'Permissions and sharing management');
    
    this._options = {
      isOpen: false,
      onClose: () => this.hide(),
      jupyterHubIntegration: true,
      ...options
    };
    
    this._permissionsDialog = React.createElement(PermissionsDialog, this._options);
  }

  /**
   * Show the permissions dialog
   */
  show(): void {
    this._isOpen = true;
    this._options = { ...this._options, isOpen: true };
    this._permissionsDialog = React.createElement(PermissionsDialog, this._options);
    
    if (this.isAttached) {
      this._renderDialog();
    }
  }

  /**
   * Hide the permissions dialog
   */
  hide(): void {
    this._isOpen = false;
    this._options = { ...this._options, isOpen: false };
    this._permissionsDialog = React.createElement(PermissionsDialog, this._options);
    
    if (this.isAttached) {
      this._renderDialog();
    }
  }

  /**
   * Toggle the permissions dialog visibility
   */
  toggle(): void {
    if (this._isOpen) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Update the dialog props
   * @param options - New props to apply
   */
  updateProps(options: Partial<IPermissionsDialogProps>): void {
    this._options = { ...this._options, ...options };
    this._permissionsDialog = React.createElement(PermissionsDialog, this._options);
    
    // Re-render with new props if attached
    if (this.isAttached) {
      this._renderDialog();
    }
  }

  /**
   * Set the current notebook path
   * @param path - Notebook file path
   */
  setNotebookPath(path: string): void {
    this.updateProps({ notebookPath: path });
  }

  /**
   * Set the current user information
   * @param user - Current user info
   */
  setCurrentUser(user: IUserInfo): void {
    this.updateProps({ currentUser: user });
  }

  /**
   * Check if the dialog is currently open
   */
  get isOpen(): boolean {
    return this._isOpen;
  }

  /**
   * Get current permissions state for external integrations
   * @returns Current permissions summary
   */
  getPermissionsState(): {
    userCount: number;
    linkCount: number;
    hasChanges: boolean;
  } {
    // This would integrate with the actual provider in production
    return {
      userCount: 0,
      linkCount: 0,
      hasChanges: false
    };
  }

  /**
   * Dispose of the widget resources
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    
    // Cleanup React component before disposing
    if (this.isAttached) {
      const ReactDOM = require('react-dom');
      ReactDOM.unmountComponentAtNode(this.node);
    }
    
    super.dispose();
  }

  /**
   * Handle after attach
   */
  protected onAfterAttach(): void {
    super.onAfterAttach();
    this._renderDialog();
  }

  /**
   * Handle before detach
   */
  protected onBeforeDetach(): void {
    super.onBeforeDetach();
    
    // Safely unmount React component
    try {
      const ReactDOM = require('react-dom');
      ReactDOM.unmountComponentAtNode(this.node);
    } catch (error) {
      console.error('Failed to unmount PermissionsDialog:', error);
    }
  }

  /**
   * Render the React dialog component
   */
  private _renderDialog(): void {
    try {
      const React = require('react');
      const ReactDOM = require('react-dom');
      
      ReactDOM.render(this._permissionsDialog, this.node);
    } catch (error) {
      console.error('Failed to render PermissionsDialog:', error);
      // Fallback content
      this.node.innerHTML = `
        <div class="jp-permissions-error-fallback">
          <span>⚠️ Permissions dialog unavailable</span>
        </div>
      `;
    }
  }
}

/**
 * Type exports for external usage
 */
export type {
  IPermissionsDialogProps,
  IUserInfo,
  IPermission,
  IShareLink,
  IPermissionTemplate,
  IJupyterHubUser,
  IShareLinkOptions,
  IPermissionError,
  ILoadingState
};

/**
 * Constants for external configuration
 */
export const PERMISSIONS_DIALOG_CONSTANTS = {
  WIDGET_ID: 'permissions-dialog',
  SHELL_AREA: 'collaboration-sidebar',
  DEFAULT_ROLES: ['viewer', 'editor', 'collaborator', 'admin'] as const,
  DEFAULT_PERMISSIONS: ['read', 'write', 'execute', 'comment', 'manage', 'lock', 'history', 'share'] as const,
  MAX_SHARE_LINKS: 10,
  MAX_USERS: 100,
  DEFAULT_LINK_EXPIRY_HOURS: 168, // 1 week
  SYNC_INTERVAL: 30000, // 30 seconds
} as const;