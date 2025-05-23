import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { Dialog, showDialog } from '@jupyterlab/apputils';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { IPermissionsService } from '@jupyter-notebook/application';

/**
 * Role type for permission assignments
 */
enum Role {
  Owner = 'owner',
  Editor = 'editor',
  Viewer = 'viewer'
}

/**
 * Interface for user information
 */
interface IUser {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
}

/**
 * Interface for sharing link
 */
interface ISharingLink {
  id: string;
  url: string;
  role: Role;
  expiresAt?: number;
  isActive: boolean;
}

/**
 * Props for the PermissionsDialog component
 */
interface IPermissionsDialogProps {
  /**
   * The permissions service
   */
  permissionsService: IPermissionsService;

  /**
   * The document path
   */
  documentPath: string;

  /**
   * The translator
   */
  translator?: ITranslator;

  /**
   * Callback when dialog is closed
   */
  onClose?: () => void;
}

/**
 * PermissionsDialog component for managing notebook access permissions
 */
const PermissionsDialog: React.FC<IPermissionsDialogProps> = ({
  permissionsService,
  documentPath,
  translator = nullTranslator,
  onClose
}) => {
  const trans = translator.load('notebook');
  
  // State for document permissions
  const [documentPermissions, setDocumentPermissions] = useState<IPermissionsService.IDocumentPermissions | null>(null);
  
  // State for users with access
  const [users, setUsers] = useState<Map<string, IPermissionsService.IUserPermissions>>(new Map());
  
  // State for sharing links
  const [sharingLinks, setSharingLinks] = useState<ISharingLink[]>([]);
  
  // State for loading status
  const [isLoading, setIsLoading] = useState<boolean>(true);
  
  // State for error message
  const [errorMessage, setErrorMessage] = useState<string>('');
  
  // State for user search
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<IUser[]>([]);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  
  // State for new link creation
  const [newLinkRole, setNewLinkRole] = useState<Role>(Role.Viewer);
  const [newLinkExpiration, setNewLinkExpiration] = useState<string>('never');
  const [isCreatingLink, setIsCreatingLink] = useState<boolean>(false);
  
  // State for active tab
  const [activeTab, setActiveTab] = useState<'people' | 'links'>('people');

  /**
   * Load document permissions and users
   */
  const loadPermissions = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');
    
    try {
      // Load document permissions
      const permissions = await permissionsService.getDocumentPermissions(documentPath);
      setDocumentPermissions(permissions);
      
      // Load users with access
      const userMap = await permissionsService.getDocumentUsers(documentPath);
      setUsers(userMap);
      
      // TODO: In a real implementation, we would load sharing links from a dedicated API
      // This is a placeholder for demonstration purposes
      setSharingLinks([
        {
          id: 'link-1',
          url: `${window.location.origin}/notebooks/${documentPath}?token=abc123`,
          role: Role.Viewer,
          isActive: true
        }
      ]);
    } catch (error) {
      console.error('Failed to load permissions:', error);
      setErrorMessage(trans.__('Failed to load permissions. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  }, [documentPath, permissionsService, trans]);

  /**
   * Search for users
   */
  const searchUsers = useCallback(async (query: string) => {
    if (!query || query.length < 2) {
      setSearchResults([]);
      return;
    }
    
    setIsSearching(true);
    
    try {
      // TODO: In a real implementation, we would call a JupyterHub API to search for users
      // This is a placeholder for demonstration purposes
      setTimeout(() => {
        const results: IUser[] = [
          {
            id: 'user1',
            name: 'Alice Johnson',
            email: 'alice@example.com',
            avatar: 'https://via.placeholder.com/40'
          },
          {
            id: 'user2',
            name: 'Bob Smith',
            email: 'bob@example.com',
            avatar: 'https://via.placeholder.com/40'
          }
        ].filter(user => 
          user.name.toLowerCase().includes(query.toLowerCase()) || 
          (user.email && user.email.toLowerCase().includes(query.toLowerCase()))
        );
        
        setSearchResults(results);
        setIsSearching(false);
      }, 500);
    } catch (error) {
      console.error('Failed to search users:', error);
      setIsSearching(false);
    }
  }, []);

  /**
   * Add a user with specified role
   */
  const addUser = useCallback(async (user: IUser, role: Role) => {
    try {
      const userPermissions: IPermissionsService.IUserPermissions = {
        read: true,
        write: role === Role.Owner || role === Role.Editor,
        comment: role === Role.Owner || role === Role.Editor,
        manage: role === Role.Owner
      };
      
      await permissionsService.setUserPermissions(documentPath, user.id, userPermissions);
      
      // Update local state
      setUsers(prev => {
        const newMap = new Map(prev);
        newMap.set(user.id, userPermissions);
        return newMap;
      });
      
      // Clear search results
      setSearchQuery('');
      setSearchResults([]);
    } catch (error) {
      console.error('Failed to add user:', error);
      setErrorMessage(trans.__('Failed to add user. Please try again.'));
    }
  }, [documentPath, permissionsService, trans]);

  /**
   * Update a user's role
   */
  const updateUserRole = useCallback(async (userId: string, role: Role) => {
    try {
      const userPermissions: IPermissionsService.IUserPermissions = {
        read: true,
        write: role === Role.Owner || role === Role.Editor,
        comment: role === Role.Owner || role === Role.Editor,
        manage: role === Role.Owner
      };
      
      await permissionsService.setUserPermissions(documentPath, userId, userPermissions);
      
      // Update local state
      setUsers(prev => {
        const newMap = new Map(prev);
        newMap.set(userId, userPermissions);
        return newMap;
      });
    } catch (error) {
      console.error('Failed to update user role:', error);
      setErrorMessage(trans.__('Failed to update user role. Please try again.'));
    }
  }, [documentPath, permissionsService, trans]);

  /**
   * Remove a user's access
   */
  const removeUser = useCallback(async (userId: string) => {
    try {
      // In a real implementation, we would call an API to remove the user's access
      // For now, we'll just update the local state
      
      // Check if user is the owner
      if (documentPermissions && documentPermissions.owner === userId) {
        setErrorMessage(trans.__('Cannot remove the owner of the document.'));
        return;
      }
      
      // Update local state
      setUsers(prev => {
        const newMap = new Map(prev);
        newMap.delete(userId);
        return newMap;
      });
    } catch (error) {
      console.error('Failed to remove user:', error);
      setErrorMessage(trans.__('Failed to remove user. Please try again.'));
    }
  }, [documentPermissions, trans]);

  /**
   * Create a new sharing link
   */
  const createSharingLink = useCallback(async () => {
    setIsCreatingLink(true);
    
    try {
      // TODO: In a real implementation, we would call an API to create a sharing link
      // This is a placeholder for demonstration purposes
      
      // Calculate expiration date if needed
      let expiresAt: number | undefined;
      if (newLinkExpiration !== 'never') {
        const days = parseInt(newLinkExpiration, 10);
        expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
      }
      
      // Create a new link
      const newLink: ISharingLink = {
        id: `link-${Date.now()}`,
        url: `${window.location.origin}/notebooks/${documentPath}?token=${Math.random().toString(36).substring(2, 10)}`,
        role: newLinkRole,
        expiresAt,
        isActive: true
      };
      
      // Update local state
      setSharingLinks(prev => [...prev, newLink]);
      
      // Reset form
      setNewLinkRole(Role.Viewer);
      setNewLinkExpiration('never');
    } catch (error) {
      console.error('Failed to create sharing link:', error);
      setErrorMessage(trans.__('Failed to create sharing link. Please try again.'));
    } finally {
      setIsCreatingLink(false);
    }
  }, [documentPath, newLinkExpiration, newLinkRole, trans]);

  /**
   * Deactivate a sharing link
   */
  const deactivateLink = useCallback((linkId: string) => {
    setSharingLinks(prev => 
      prev.map(link => 
        link.id === linkId ? { ...link, isActive: false } : link
      )
    );
  }, []);

  /**
   * Copy link to clipboard
   */
  const copyLink = useCallback((url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      // Show a temporary success message
      // In a real implementation, we would use a toast notification
      console.log('Link copied to clipboard');
    });
  }, []);

  /**
   * Update document access mode
   */
  const updateAccessMode = useCallback(async (mode: 'private' | 'shared' | 'public') => {
    if (!documentPermissions) return;
    
    try {
      const updatedPermissions: IPermissionsService.IDocumentPermissions = {
        ...documentPermissions,
        accessMode: mode
      };
      
      await permissionsService.setDocumentPermissions(documentPath, updatedPermissions);
      
      // Update local state
      setDocumentPermissions(updatedPermissions);
    } catch (error) {
      console.error('Failed to update access mode:', error);
      setErrorMessage(trans.__('Failed to update access mode. Please try again.'));
    }
  }, [documentPath, documentPermissions, permissionsService, trans]);

  /**
   * Get role from user permissions
   */
  const getRoleFromPermissions = useCallback((permissions: IPermissionsService.IUserPermissions): Role => {
    if (permissions.manage) {
      return Role.Owner;
    } else if (permissions.write) {
      return Role.Editor;
    } else {
      return Role.Viewer;
    }
  }, []);

  /**
   * Format expiration date
   */
  const formatExpirationDate = useCallback((timestamp?: number): string => {
    if (!timestamp) return trans.__('Never expires');
    
    const date = new Date(timestamp);
    return date.toLocaleDateString();
  }, [trans]);

  /**
   * Load permissions on component mount
   */
  useEffect(() => {
    loadPermissions();
  }, [loadPermissions]);

  /**
   * Handle search query changes
   */
  useEffect(() => {
    const timerId = setTimeout(() => {
      searchUsers(searchQuery);
    }, 300);
    
    return () => clearTimeout(timerId);
  }, [searchQuery, searchUsers]);

  /**
   * Render access mode selector
   */
  const renderAccessModeSelector = useMemo(() => {
    if (!documentPermissions) return null;
    
    return (
      <div className="jp-PermissionsDialog-accessMode">
        <h3>{trans.__('Access')}</h3>
        <div className="jp-PermissionsDialog-accessModeOptions">
          <label>
            <input 
              type="radio" 
              name="accessMode" 
              value="private" 
              checked={documentPermissions.accessMode === 'private'} 
              onChange={() => updateAccessMode('private')}
            />
            <span>{trans.__('Private')}</span>
            <p className="jp-PermissionsDialog-accessModeDescription">
              {trans.__('Only people with access can open this notebook')}
            </p>
          </label>
          
          <label>
            <input 
              type="radio" 
              name="accessMode" 
              value="shared" 
              checked={documentPermissions.accessMode === 'shared'} 
              onChange={() => updateAccessMode('shared')}
            />
            <span>{trans.__('Shared')}</span>
            <p className="jp-PermissionsDialog-accessModeDescription">
              {trans.__('Anyone with the link can view this notebook')}
            </p>
          </label>
          
          <label>
            <input 
              type="radio" 
              name="accessMode" 
              value="public" 
              checked={documentPermissions.accessMode === 'public'} 
              onChange={() => updateAccessMode('public')}
            />
            <span>{trans.__('Public')}</span>
            <p className="jp-PermissionsDialog-accessModeDescription">
              {trans.__('Anyone can find and view this notebook')}
            </p>
          </label>
        </div>
      </div>
    );
  }, [documentPermissions, trans, updateAccessMode]);

  /**
   * Render people tab content
   */
  const renderPeopleTab = useMemo(() => {
    return (
      <div className="jp-PermissionsDialog-tabContent">
        {renderAccessModeSelector}
        
        <div className="jp-PermissionsDialog-userSearch">
          <h3>{trans.__('People with access')}</h3>
          <div className="jp-PermissionsDialog-searchBox">
            <input 
              type="text" 
              placeholder={trans.__('Add people by name or email')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {isSearching && <div className="jp-PermissionsDialog-searchSpinner" />}
          </div>
          
          {searchResults.length > 0 && (
            <div className="jp-PermissionsDialog-searchResults">
              {searchResults.map(user => (
                <div key={user.id} className="jp-PermissionsDialog-searchResultItem">
                  <div className="jp-PermissionsDialog-userInfo">
                    {user.avatar ? (
                      <img src={user.avatar} alt={user.name} className="jp-PermissionsDialog-userAvatar" />
                    ) : (
                      <div className="jp-PermissionsDialog-userInitials">
                        {user.name.split(' ').map(n => n[0]).join('').toUpperCase()}
                      </div>
                    )}
                    <div>
                      <div className="jp-PermissionsDialog-userName">{user.name}</div>
                      {user.email && <div className="jp-PermissionsDialog-userEmail">{user.email}</div>}
                    </div>
                  </div>
                  <div className="jp-PermissionsDialog-userActions">
                    <select 
                      value={Role.Viewer}
                      onChange={(e) => addUser(user, e.target.value as Role)}
                    >
                      <option value={Role.Viewer}>{trans.__('Viewer')}</option>
                      <option value={Role.Editor}>{trans.__('Editor')}</option>
                      <option value={Role.Owner}>{trans.__('Owner')}</option>
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        
        <div className="jp-PermissionsDialog-userList">
          {Array.from(users.entries()).map(([userId, permissions]) => {
            // TODO: In a real implementation, we would fetch user details from JupyterHub
            // This is a placeholder for demonstration purposes
            const isOwner = documentPermissions?.owner === userId;
            const role = getRoleFromPermissions(permissions);
            const userName = isOwner ? 'You (Owner)' : `User ${userId}`;
            
            return (
              <div key={userId} className="jp-PermissionsDialog-userItem">
                <div className="jp-PermissionsDialog-userInfo">
                  <div className="jp-PermissionsDialog-userInitials">
                    {userName.split(' ')[0][0].toUpperCase()}
                  </div>
                  <div className="jp-PermissionsDialog-userName">{userName}</div>
                </div>
                <div className="jp-PermissionsDialog-userActions">
                  <select 
                    value={role}
                    onChange={(e) => updateUserRole(userId, e.target.value as Role)}
                    disabled={isOwner}
                  >
                    <option value={Role.Viewer}>{trans.__('Viewer')}</option>
                    <option value={Role.Editor}>{trans.__('Editor')}</option>
                    <option value={Role.Owner}>{trans.__('Owner')}</option>
                  </select>
                  {!isOwner && (
                    <button 
                      className="jp-PermissionsDialog-removeButton"
                      onClick={() => removeUser(userId)}
                      title={trans.__('Remove access')}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }, [
    renderAccessModeSelector, 
    searchQuery, 
    searchResults, 
    isSearching, 
    users, 
    documentPermissions, 
    trans, 
    addUser, 
    updateUserRole, 
    removeUser, 
    getRoleFromPermissions
  ]);

  /**
   * Render links tab content
   */
  const renderLinksTab = useMemo(() => {
    return (
      <div className="jp-PermissionsDialog-tabContent">
        <div className="jp-PermissionsDialog-linkCreator">
          <h3>{trans.__('Sharing links')}</h3>
          <div className="jp-PermissionsDialog-linkForm">
            <div className="jp-PermissionsDialog-linkFormRow">
              <label>{trans.__('Access level:')}</label>
              <select 
                value={newLinkRole}
                onChange={(e) => setNewLinkRole(e.target.value as Role)}
              >
                <option value={Role.Viewer}>{trans.__('Viewer (can view)')}</option>
                <option value={Role.Editor}>{trans.__('Editor (can edit)')}</option>
              </select>
            </div>
            <div className="jp-PermissionsDialog-linkFormRow">
              <label>{trans.__('Expires:')}</label>
              <select 
                value={newLinkExpiration}
                onChange={(e) => setNewLinkExpiration(e.target.value)}
              >
                <option value="never">{trans.__('Never')}</option>
                <option value="1">{trans.__('1 day')}</option>
                <option value="7">{trans.__('7 days')}</option>
                <option value="30">{trans.__('30 days')}</option>
              </select>
            </div>
            <button 
              className="jp-PermissionsDialog-createLinkButton"
              onClick={createSharingLink}
              disabled={isCreatingLink}
            >
              {isCreatingLink ? trans.__('Creating...') : trans.__('Create link')}
            </button>
          </div>
        </div>
        
        <div className="jp-PermissionsDialog-linkList">
          {sharingLinks.length > 0 ? (
            sharingLinks.map(link => (
              <div key={link.id} className="jp-PermissionsDialog-linkItem">
                <div className="jp-PermissionsDialog-linkInfo">
                  <div className="jp-PermissionsDialog-linkRole">
                    {link.role === Role.Viewer ? trans.__('Viewer link') : trans.__('Editor link')}
                  </div>
                  <div className="jp-PermissionsDialog-linkUrl">{link.url}</div>
                  <div className="jp-PermissionsDialog-linkExpiration">
                    {link.expiresAt ? (
                      trans.__('Expires: %1', formatExpirationDate(link.expiresAt))
                    ) : (
                      trans.__('Never expires')
                    )}
                  </div>
                </div>
                <div className="jp-PermissionsDialog-linkActions">
                  <button 
                    className="jp-PermissionsDialog-copyLinkButton"
                    onClick={() => copyLink(link.url)}
                    title={trans.__('Copy link')}
                  >
                    {trans.__('Copy')}
                  </button>
                  {link.isActive && (
                    <button 
                      className="jp-PermissionsDialog-deactivateLinkButton"
                      onClick={() => deactivateLink(link.id)}
                      title={trans.__('Deactivate link')}
                    >
                      {trans.__('Deactivate')}
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="jp-PermissionsDialog-emptyState">
              {trans.__('No sharing links created yet')}
            </div>
          )}
        </div>
      </div>
    );
  }, [
    newLinkRole, 
    newLinkExpiration, 
    isCreatingLink, 
    sharingLinks, 
    trans, 
    createSharingLink, 
    copyLink, 
    deactivateLink, 
    formatExpirationDate
  ]);

  // If loading, show a loading indicator
  if (isLoading) {
    return (
      <div className="jp-PermissionsDialog-loading">
        <div className="jp-PermissionsDialog-spinner" />
        <div>{trans.__('Loading permissions...')}</div>
      </div>
    );
  }

  return (
    <div className="jp-PermissionsDialog">
      {errorMessage && (
        <div className="jp-PermissionsDialog-error">
          {errorMessage}
          <button 
            className="jp-PermissionsDialog-errorDismiss"
            onClick={() => setErrorMessage('')}
          >
            ×
          </button>
        </div>
      )}
      
      <div className="jp-PermissionsDialog-tabs">
        <button 
          className={`jp-PermissionsDialog-tab ${activeTab === 'people' ? 'jp-PermissionsDialog-activeTab' : ''}`}
          onClick={() => setActiveTab('people')}
        >
          {trans.__('People')}
        </button>
        <button 
          className={`jp-PermissionsDialog-tab ${activeTab === 'links' ? 'jp-PermissionsDialog-activeTab' : ''}`}
          onClick={() => setActiveTab('links')}
        >
          {trans.__('Links')}
        </button>
      </div>
      
      {activeTab === 'people' ? renderPeopleTab : renderLinksTab}
    </div>
  );
};

/**
 * A namespace for PermissionsDialog statics.
 */
export namespace PermissionsDialogComponent {
  /**
   * Create a new PermissionsDialog widget.
   */
  export function create(options: {
    permissionsService: IPermissionsService;
    documentPath: string;
    translator?: ITranslator;
  }): ReactWidget {
    return ReactWidget.create(
      <PermissionsDialog
        permissionsService={options.permissionsService}
        documentPath={options.documentPath}
        translator={options.translator}
      />
    );
  }

  /**
   * Show the permissions dialog.
   */
  export function showDialog(options: {
    permissionsService: IPermissionsService;
    documentPath: string;
    translator?: ITranslator;
  }): Promise<Dialog.IResult<void>> {
    const dialogWidget = create(options);
    
    return showDialog({
      title: options.translator?.load('notebook').__("Manage Access") || "Manage Access",
      body: dialogWidget,
      buttons: [Dialog.okButton({ label: options.translator?.load('notebook').__("Done") || "Done" })]
    });
  }
}

export default PermissionsDialogComponent;