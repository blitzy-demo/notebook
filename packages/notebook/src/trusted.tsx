/**
 * @fileoverview Enhanced trusted component for collaborative notebook security
 * 
 * This module provides comprehensive security features for collaborative notebook editing
 * including multi-user trust verification, security indicators for collaborative sessions,
 * and integration with the collaborative permissions system. It extends the standard
 * trust functionality to support real-time collaborative environments with proper
 * security validation across multiple users.
 * 
 * Key features:
 * - Multi-user trust verification with collaborative security validation
 * - Security indicators and warnings for collaborative sessions
 * - Integration with permission system for access control
 * - Real-time security state synchronization across collaborators
 * - Comprehensive trust validation for collaborative operations
 * 
 * @author Blitzy Agent
 * @version 1.0.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { ReactWidget } from '@jupyterlab/apputils';
import { NotebookActions, NotebookPanel } from '@jupyterlab/notebook';
import { ITranslator } from '@jupyterlab/translation';

// Import collaborative services
import { PermissionService, PermissionOperation } from './collab/permissions';
import { AwarenessService, UserStatus } from './collab/awareness';

/**
 * Interface for collaborative trust state information
 */
interface ICollaborativeTrustState {
  /** Whether the notebook is trusted by all collaborators */
  isCollaborativelyTrusted: boolean;
  /** Map of user trust states */
  userTrustStates: Record<string, boolean>;
  /** Security warnings for collaborative session */
  securityWarnings: string[];
  /** Trust verification results */
  verificationResults: ITrustVerificationResult[];
  /** Last trust check timestamp */
  lastVerification: Date;
}

/**
 * Interface for trust verification results
 */
interface ITrustVerificationResult {
  /** User ID who performed the verification */
  userId: string;
  /** Whether the verification passed */
  passed: boolean;
  /** Reason for the verification result */
  reason: string;
  /** Timestamp of the verification */
  timestamp: Date;
  /** Cell ID if verification was cell-specific */
  cellId?: string;
}

/**
 * Interface for security indicators
 */
interface ISecurityIndicator {
  /** Type of security indicator */
  type: 'warning' | 'error' | 'info' | 'success';
  /** Message to display */
  message: string;
  /** Whether the indicator is critical */
  critical: boolean;
  /** Associated action (if any) */
  action?: () => void;
}

/**
 * Enhanced function to check if a notebook is trusted with collaborative support
 * @param notebook The notebook panel to check
 * @returns true if the notebook is trusted, false otherwise
 */
export const isTrusted = (notebook: NotebookPanel): boolean => {
  if (!notebook || !notebook.content || !notebook.content.model) {
    return false;
  }

  const model = notebook.content.model;
  const cells = Array.from(model.cells);
  let total = 0;
  let trusted = 0;

  for (const currentCell of cells) {
    if ((currentCell as any).type !== 'code') {
      continue;
    }
    total++;
    if ((currentCell as any).trusted) {
      trusted++;
    }
  }

  return trusted === total;
};

/**
 * Enhanced trusted button component with collaborative security features
 * @param notebook The notebook panel
 * @param translator The translation service
 * @param permissionService The permission service for access control
 * @param awarenessService The awareness service for user tracking
 */
export const TrustedButton = ({
  notebook,
  translator,
  permissionService,
  awarenessService,
}: {
  notebook: NotebookPanel;
  translator: ITranslator;
  permissionService?: PermissionService;
  awarenessService?: AwarenessService;
}): JSX.Element => {
  const trans = translator.load('notebook');
  const [trusted, setTrusted] = useState(isTrusted(notebook));
  const [collaborativeTrust, setCollaborativeTrust] = useState<ICollaborativeTrustState>({
    isCollaborativelyTrusted: false,
    userTrustStates: {},
    securityWarnings: [],
    verificationResults: [],
    lastVerification: new Date()
  });
  const [canEdit, setCanEdit] = useState(true);
  const [securityIndicators, setSecurityIndicators] = useState<ISecurityIndicator[]>([]);

  // Check basic trust state
  const checkTrust = useCallback(() => {
    const trustState = isTrusted(notebook);
    setTrusted(trustState);
    
    // Check collaborative trust if services are available
    if (permissionService && awarenessService) {
      checkCollaborativeTrust();
    }
  }, [notebook, permissionService, awarenessService]);

  // Check collaborative trust state
  const checkCollaborativeTrust = useCallback(async () => {
    if (!permissionService || !awarenessService) {
      return;
    }

    try {
      const users = awarenessService.getUsers();
      const userTrustStates: Record<string, boolean> = {};
      const verificationResults: ITrustVerificationResult[] = [];
      const securityWarnings: string[] = [];

      // Check trust state for each collaborator
      for (const user of users) {
        const userTrusted = await verifyUserTrust(user.userId);
        userTrustStates[user.userId] = userTrusted;
        
        verificationResults.push({
          userId: user.userId,
          passed: userTrusted,
          reason: userTrusted ? 'Trust verification passed' : 'Trust verification failed',
          timestamp: new Date()
        });

        if (!userTrusted) {
          securityWarnings.push(`User ${user.name} has not verified notebook trust`);
        }
      }

      // Check if all collaborators have verified trust
      const allTrusted = Object.values(userTrustStates).every(trusted => trusted);
      
      setCollaborativeTrust({
        isCollaborativelyTrusted: allTrusted && trusted,
        userTrustStates,
        securityWarnings,
        verificationResults,
        lastVerification: new Date()
      });

      // Update security indicators
      updateSecurityIndicators(allTrusted, securityWarnings);
    } catch (error) {
      console.error('Error checking collaborative trust:', error);
    }
  }, [permissionService, awarenessService, trusted]);

  // Verify trust for a specific user
  const verifyUserTrust = async (userId: string): Promise<boolean> => {
    if (!permissionService) {
      return false;
    }

    try {
      // Check if user has permission to execute trusted code
      const hasPermission = await permissionService.checkPermission(PermissionOperation.EXECUTE);
      return hasPermission && trusted;
    } catch (error) {
      console.error(`Error verifying trust for user ${userId}:`, error);
      return false;
    }
  };

  // Update security indicators based on trust state
  const updateSecurityIndicators = (allTrusted: boolean, warnings: string[]) => {
    const indicators: ISecurityIndicator[] = [];

    if (!trusted) {
      indicators.push({
        type: 'warning',
        message: trans.__('JavaScript is disabled for this notebook'),
        critical: true
      });
    }

    if (!allTrusted && warnings.length > 0) {
      indicators.push({
        type: 'warning',
        message: trans.__('Some collaborators have not verified notebook trust'),
        critical: false
      });
    }

    if (collaborativeTrust.securityWarnings.length > 0) {
      indicators.push({
        type: 'info',
        message: trans.__(`${collaborativeTrust.securityWarnings.length} security warnings`),
        critical: false
      });
    }

    setSecurityIndicators(indicators);
  };

  // Check edit permissions
  const checkEditPermissions = useCallback(async () => {
    if (permissionService) {
      try {
        const canEditResult = await permissionService.canEdit();
        setCanEdit(canEditResult);
      } catch (error) {
        console.error('Error checking edit permissions:', error);
        setCanEdit(false);
      }
    }
  }, [permissionService]);

  // Trust the notebook with collaborative verification
  const trust = async () => {
    if (!canEdit) {
      return;
    }

    try {
      await NotebookActions.trust(notebook.content, translator);
      checkTrust();
      
      // Notify other collaborators about trust change
      if (awarenessService) {
        const currentUser = awarenessService.getCurrentUser();
        if (currentUser) {
          // Update user status to indicate trust verification
          awarenessService.updateUserStatus(UserStatus.EDITING);
        }
      }
    } catch (error) {
      console.error('Error trusting notebook:', error);
    }
  };

  // Set up event listeners
  useEffect(() => {
    if (notebook && notebook.content) {
      notebook.content.modelContentChanged.connect(checkTrust);
      notebook.content.activeCellChanged.connect(checkTrust);
      checkTrust();
      checkEditPermissions();

      return () => {
        notebook.content.modelContentChanged.disconnect(checkTrust);
        notebook.content.activeCellChanged.disconnect(checkTrust);
      };
    }
  }, [notebook, checkTrust, checkEditPermissions]);

  // Listen for permission changes
  useEffect(() => {
    if (permissionService) {
      const onPermissionChanged = () => {
        checkEditPermissions();
        checkCollaborativeTrust();
      };

      permissionService.onPermissionChanged.connect(onPermissionChanged);

      return () => {
        permissionService.onPermissionChanged.disconnect(onPermissionChanged);
      };
    }
  }, [permissionService, checkEditPermissions, checkCollaborativeTrust]);

  // Listen for user presence changes
  useEffect(() => {
    if (awarenessService) {
      const onUserJoin = () => checkCollaborativeTrust();
      const onUserLeave = () => checkCollaborativeTrust();

      awarenessService.onUserJoin.connect(onUserJoin);
      awarenessService.onUserLeave.connect(onUserLeave);

      return () => {
        awarenessService.onUserJoin.disconnect(onUserJoin);
        awarenessService.onUserLeave.disconnect(onUserLeave);
      };
    }
  }, [awarenessService, checkCollaborativeTrust]);

  // Determine button style and tooltip based on trust and permission state
  const getButtonStyle = () => {
    if (!canEdit) {
      return { cursor: 'not-allowed', opacity: 0.6 };
    }
    return !trusted ? { cursor: 'pointer' } : { cursor: 'help' };
  };

  const getTooltip = () => {
    if (!canEdit) {
      return trans.__('Insufficient permissions to modify trust settings');
    }
    if (!trusted) {
      return trans.__('JavaScript disabled for notebook display - Click to trust');
    }
    if (!collaborativeTrust.isCollaborativelyTrusted) {
      return trans.__('JavaScript enabled - Some collaborators have not verified trust');
    }
    return trans.__('JavaScript enabled for notebook display');
  };

  const getButtonText = () => {
    if (!trusted) {
      return trans.__('Not Trusted');
    }
    if (!collaborativeTrust.isCollaborativelyTrusted) {
      return trans.__('Partially Trusted');
    }
    return trans.__('Trusted');
  };

  const getButtonClass = () => {
    let className = 'jp-NotebookTrustedStatus';
    if (!trusted) {
      className += ' jp-NotebookTrustedStatus-untrusted';
    } else if (!collaborativeTrust.isCollaborativelyTrusted) {
      className += ' jp-NotebookTrustedStatus-partial';
    } else {
      className += ' jp-NotebookTrustedStatus-trusted';
    }
    return className;
  };

  return (
    <div className="jp-NotebookTrustedContainer">
      <button
        className={getButtonClass()}
        style={getButtonStyle()}
        onClick={() => !trusted && canEdit && trust()}
        title={getTooltip()}
        disabled={!canEdit}
      >
        {getButtonText()}
      </button>
      {securityIndicators.map((indicator, index) => (
        <SecurityIndicator
          key={index}
          type={indicator.type}
          message={indicator.message}
          critical={indicator.critical}
          action={indicator.action}
        />
      ))}
    </div>
  );
};

/**
 * Security indicator component for displaying collaborative security warnings
 * @param type The type of security indicator
 * @param message The message to display
 * @param critical Whether the indicator is critical
 * @param action Optional action to perform when clicked
 */
export const SecurityIndicator = ({
  type,
  message,
  critical,
  action
}: {
  type: 'warning' | 'error' | 'info' | 'success';
  message: string;
  critical: boolean;
  action?: () => void;
}): JSX.Element => {
  const getIndicatorClass = () => {
    let className = 'jp-SecurityIndicator';
    className += ` jp-SecurityIndicator-${type}`;
    if (critical) {
      className += ' jp-SecurityIndicator-critical';
    }
    return className;
  };

  return (
    <div 
      className={getIndicatorClass()}
      onClick={action}
      style={{ cursor: action ? 'pointer' : 'default' }}
      title={message}
    >
      <span className="jp-SecurityIndicator-icon">
        {type === 'warning' && '⚠️'}
        {type === 'error' && '❌'}
        {type === 'info' && 'ℹ️'}
        {type === 'success' && '✅'}
      </span>
      <span className="jp-SecurityIndicator-message">{message}</span>
    </div>
  );
};

/**
 * Collaborative trust verifier class for managing multi-user trust verification
 */
export class CollaborativeTrustVerifier {
  private _notebook: NotebookPanel;
  private _permissionService: PermissionService;
  private _awarenessService: AwarenessService;

  constructor(
    notebook: NotebookPanel,
    permissionService: PermissionService,
    awarenessService: AwarenessService
  ) {
    this._notebook = notebook;
    this._permissionService = permissionService;
    this._awarenessService = awarenessService;
  }

  /**
   * Verify collaborative trust across all users
   * @returns Promise resolving to collaborative trust verification result
   */
  async verifyCollaborativeTrust(): Promise<{
    isValid: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    try {
      // Check basic notebook trust
      const basicTrust = isTrusted(this._notebook);
      if (!basicTrust) {
        issues.push('Notebook is not trusted locally');
        recommendations.push('Trust the notebook to enable JavaScript execution');
      }

      // Check multi-user trust
      const multiUserTrust = await this.checkMultiUserTrust();
      if (!multiUserTrust.allUsersVerified) {
        issues.push('Not all collaborators have verified trust');
        recommendations.push('Ensure all collaborators verify notebook trust');
      }

      // Check permissions
      const permissionValidation = await this.validateUserPermissions();
      if (!permissionValidation.isValid) {
        issues.push(...permissionValidation.issues);
        recommendations.push(...permissionValidation.recommendations);
      }

      return {
        isValid: issues.length === 0,
        issues,
        recommendations
      };
    } catch (error) {
      console.error('Error verifying collaborative trust:', error);
      return {
        isValid: false,
        issues: ['Error during trust verification'],
        recommendations: ['Please try again or contact support']
      };
    }
  }

  /**
   * Check multi-user trust state
   * @returns Promise resolving to multi-user trust verification result
   */
  async checkMultiUserTrust(): Promise<{
    allUsersVerified: boolean;
    userStates: Record<string, boolean>;
    unverifiedUsers: string[];
  }> {
    const users = this._awarenessService.getUsers();
    const userStates: Record<string, boolean> = {};
    const unverifiedUsers: string[] = [];

    for (const user of users) {
      try {
        const userTrusted = await this._verifyUserTrust(user.userId);
        userStates[user.userId] = userTrusted;
        
        if (!userTrusted) {
          unverifiedUsers.push(user.name);
        }
      } catch (error) {
        console.error(`Error checking trust for user ${user.userId}:`, error);
        userStates[user.userId] = false;
        unverifiedUsers.push(user.name);
      }
    }

    return {
      allUsersVerified: unverifiedUsers.length === 0,
      userStates,
      unverifiedUsers
    };
  }

  /**
   * Get security indicators for the current collaborative session
   * @returns Array of security indicators
   */
  getSecurityIndicators(): ISecurityIndicator[] {
    const indicators: ISecurityIndicator[] = [];

    // Check basic trust
    if (!isTrusted(this._notebook)) {
      indicators.push({
        type: 'warning',
        message: 'Notebook is not trusted - JavaScript execution disabled',
        critical: true,
        action: () => this._trustNotebook()
      });
    }

    // Check collaborative trust
    const users = this._awarenessService.getUsers();
    const onlineUsers = users.filter(user => user.isActive);
    
    if (onlineUsers.length > 1) {
      indicators.push({
        type: 'info',
        message: `Collaborative session active with ${onlineUsers.length} users`,
        critical: false
      });
    }

    // Check permissions
    if (!this._permissionService) {
      indicators.push({
        type: 'warning',
        message: 'Permission service not available',
        critical: false
      });
    }

    return indicators;
  }

  /**
   * Validate user permissions for collaborative operations
   * @returns Promise resolving to permission validation result
   */
  async validateUserPermissions(): Promise<{
    isValid: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    try {
      // Check if current user can edit
      const canEdit = await this._permissionService.canEdit();
      if (!canEdit) {
        issues.push('Insufficient permissions to modify notebook');
        recommendations.push('Request edit permissions from notebook owner');
      }

      // Check if current user can admin
      const canAdmin = await this._permissionService.canAdmin();
      if (!canAdmin) {
        issues.push('Cannot manage collaborative settings');
        recommendations.push('Contact notebook owner for administrative access');
      }

      // Check collaborator permissions
      const collaborators = await this._permissionService.getCollaborators();
      const viewers = collaborators.filter(c => c.role === 'view');
      
      if (viewers.length > 0) {
        issues.push(`${viewers.length} collaborators have view-only access`);
        recommendations.push('Consider upgrading viewer permissions for full collaboration');
      }

      return {
        isValid: issues.length === 0,
        issues,
        recommendations
      };
    } catch (error) {
      console.error('Error validating permissions:', error);
      return {
        isValid: false,
        issues: ['Error validating permissions'],
        recommendations: ['Please try again or contact support']
      };
    }
  }

  /**
   * Verify trust for a specific user
   * @param userId The user ID to verify trust for
   * @returns Promise resolving to trust verification result
   */
  private async _verifyUserTrust(userId: string): Promise<boolean> {
    try {
      // Check if user has permission to execute trusted code
      const hasPermission = await this._permissionService.checkPermission(PermissionOperation.EXECUTE);
      
      // Check if notebook is trusted
      const notebookTrusted = isTrusted(this._notebook);
      
      return hasPermission && notebookTrusted;
    } catch (error) {
      console.error(`Error verifying trust for user ${userId}:`, error);
      return false;
    }
  }

  /**
   * Trust the notebook and notify collaborators
   */
  private async _trustNotebook(): Promise<void> {
    try {
      if (this._notebook && this._notebook.content) {
        await NotebookActions.trust(this._notebook.content);
        
        // Notify collaborators about trust change
        const currentUser = this._awarenessService.getCurrentUser();
        if (currentUser) {
          this._awarenessService.updateUserStatus(UserStatus.EDITING);
        }
      }
    } catch (error) {
      console.error('Error trusting notebook:', error);
    }
  }
}

/**
 * Namespace for TrustedComponent with enhanced collaborative support
 */
export const TrustedComponent = {
  /**
   * Create a new trusted component with collaborative features
   * @param notebook The notebook panel
   * @param translator The translator service
   * @param permissionService Optional permission service for collaboration
   * @param awarenessService Optional awareness service for user tracking
   * @returns A new ReactWidget containing the trusted component
   */
  create: ({
    notebook,
    translator,
    permissionService,
    awarenessService,
  }: {
    notebook: NotebookPanel;
    translator: ITranslator;
    permissionService?: PermissionService;
    awarenessService?: AwarenessService;
  }): ReactWidget => {
    return ReactWidget.create(
      <TrustedButton
        notebook={notebook}
        translator={translator}
        permissionService={permissionService}
        awarenessService={awarenessService}
      />
    );
  }
};