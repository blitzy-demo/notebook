// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  JupyterLab,
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from '@jupyterlab/application';

import { Base64ModelFactory } from '@jupyterlab/docregistry';

import { createRendermimePlugins } from '@jupyterlab/application/lib/mimerenderers';

import { LabStatus } from '@jupyterlab/application/lib/status';

import { PageConfig } from '@jupyterlab/coreutils';

import { IRenderMime } from '@jupyterlab/rendermime-interfaces';

import { Throttler } from '@lumino/polling';

import { INotebookShell, NotebookShell } from './shell';

// Collaboration service imports
import {
  ICollaborationManager,
  IUserAwareness,
  ILockManager,
  IHistoryManager,
  IPermissionManager,
  ICommentManager
} from './tokens';

// Collaboration implementation imports
import YjsNotebookProvider from '../../notebook/src/collab/provider';
import UserAwareness from '../../notebook/src/collab/awareness';
import CellLocking from '../../notebook/src/collab/locks';
import ChangeHistory from '../../notebook/src/collab/history';
import PermissionsSystem from '../../notebook/src/collab/permissions';
import CommentSystem from '../../notebook/src/collab/comments';

// Yjs and external collaboration dependencies are imported by the specific collaboration components

/**
 * App is the main application class. It is instantiated once and shared.
 */
export class NotebookApp extends JupyterFrontEnd<INotebookShell> {
  /**
   * Construct a new NotebookApp object.
   *
   * @param options The instantiation options for an application.
   */
  constructor(options: NotebookApp.IOptions = { shell: new NotebookShell() }) {
    super({ ...options, shell: options.shell ?? new NotebookShell() });

    // Add initial model factory.
    this.docRegistry.addModelFactory(new Base64ModelFactory());
    if (options.mimeExtensions) {
      for (const plugin of createRendermimePlugins(options.mimeExtensions)) {
        this.registerPlugin(plugin);
      }
    }

    // Create an IInfo dictionary from the options to override the defaults.
    const info = Object.keys(JupyterLab.defaultInfo).reduce((acc, val) => {
      if (val in options) {
        (acc as any)[val] = JSON.parse(JSON.stringify((options as any)[val]));
      }
      return acc;
    }, {} as Partial<JupyterLab.IInfo>);

    // Populate application info.
    this._info = { ...JupyterLab.defaultInfo, ...info };

    this.restored = this.shell.restored;

    // Initialize collaboration services before UI rendering
    this._initializeCollaborationServices();

    // Register collaboration plugins after services are initialized
    if (this._collaborationInitialized) {
      this.registerCollaborationPlugins();
    }

    this.restored.then(() => this._formatter.invoke());
  }

  /**
   * The name of the application.
   */
  readonly name = 'Jupyter Notebook';

  /**
   * A namespace/prefix plugins may use to denote their provenance.
   */
  readonly namespace = this.name;

  /**
   * The application busy and dirty status signals and flags.
   */
  readonly status = new LabStatus(this);

  /**
   * Promise that resolves when the state is first restored
   */
  readonly restored: Promise<void>;

  /**
   * The version of the application.
   */

  readonly version = PageConfig.getOption('appVersion') ?? 'unknown';

  /**
   * The NotebookApp application information dictionary.
   */
  get info(): JupyterLab.IInfo {
    return this._info;
  }

  /**
   * The JupyterLab application paths dictionary.
   */
  get paths(): JupyterFrontEnd.IPaths {
    return {
      urls: {
        base: PageConfig.getOption('baseUrl'),
        notFound: PageConfig.getOption('notFoundUrl'),
        app: PageConfig.getOption('appUrl'),
        static: PageConfig.getOption('staticUrl'),
        settings: PageConfig.getOption('settingsUrl'),
        themes: PageConfig.getOption('themesUrl'),
        doc: PageConfig.getOption('docUrl'),
        translations: PageConfig.getOption('translationsApiUrl'),
        hubHost: PageConfig.getOption('hubHost') || undefined,
        hubPrefix: PageConfig.getOption('hubPrefix') || undefined,
        hubUser: PageConfig.getOption('hubUser') || undefined,
        hubServerName: PageConfig.getOption('hubServerName') || undefined,
      },
      directories: {
        appSettings: PageConfig.getOption('appSettingsDir'),
        schemas: PageConfig.getOption('schemasDir'),
        static: PageConfig.getOption('staticDir'),
        templates: PageConfig.getOption('templatesDir'),
        themes: PageConfig.getOption('themesDir'),
        userSettings: PageConfig.getOption('userSettingsDir'),
        serverRoot: PageConfig.getOption('serverRoot'),
        workspaces: PageConfig.getOption('workspacesDir'),
      },
    };
  }

  /**
   * Handle the DOM events for the application.
   *
   * @param event - The DOM event sent to the application.
   */
  handleEvent(event: Event): void {
    super.handleEvent(event);
    if (event.type === 'resize') {
      void this._formatter.invoke();
    }
  }

  /**
   * Register plugins from a plugin module.
   *
   * @param mod - The plugin module to register.
   */
  registerPluginModule(mod: NotebookApp.IPluginModule): void {
    let data = mod.default;
    // Handle commonjs exports.
    if (!Object.prototype.hasOwnProperty.call(mod, '__esModule')) {
      data = mod as any;
    }
    if (!Array.isArray(data)) {
      data = [data];
    }
    data.forEach((item) => {
      try {
        this.registerPlugin(item);
      } catch (error) {
        console.error(error);
      }
    });
  }

  /**
   * Register the plugins from multiple plugin modules.
   *
   * @param mods - The plugin modules to register.
   */
  registerPluginModules(mods: NotebookApp.IPluginModule[]): void {
    mods.forEach((mod) => {
      this.registerPluginModule(mod);
    });
  }

  /**
   * Register collaboration plugins with proper activation order
   * This ensures collaboration plugins are activated after notebook-extension
   * but before UI rendering to prevent synchronization issues
   */
  registerCollaborationPlugins(): void {
    if (!this._collaborationInitialized) {
      console.warn('Collaboration services not initialized, skipping plugin registration');
      return;
    }

    // Define collaboration plugins in dependency order
    const collaborationPlugins: JupyterFrontEndPlugin<any>[] = [
      // Core collaboration provider plugin
      {
        id: '@jupyter-notebook/collaboration:yjs-provider',
        description: 'Yjs document provider for real-time collaboration',
        autoStart: true,
        provides: ICollaborationManager,
        activate: (app: JupyterFrontEnd) => {
          console.log('Yjs provider plugin activated');
          const notebookApp = app as NotebookApp;
          return notebookApp.collaborationManager;
        }
      },
      
      // User awareness plugin
      {
        id: '@jupyter-notebook/collaboration:user-awareness',
        description: 'User presence tracking for collaborative editing',
        autoStart: true,
        provides: IUserAwareness,
        activate: (app: JupyterFrontEnd) => {
          console.log('User awareness plugin activated');
          const notebookApp = app as NotebookApp;
          return notebookApp.userAwareness;
        }
      },
      
      // Cell locking plugin
      {
        id: '@jupyter-notebook/collaboration:cell-locking',
        description: 'Cell-level locking for conflict prevention',
        autoStart: true,
        provides: ILockManager,
        activate: (app: JupyterFrontEnd) => {
          console.log('Cell locking plugin activated');
          const notebookApp = app as NotebookApp;
          return notebookApp.lockManager;
        }
      },
      
      // History tracking plugin
      {
        id: '@jupyter-notebook/collaboration:change-history',
        description: 'Change history and version tracking',
        autoStart: true,
        provides: IHistoryManager,
        activate: (app: JupyterFrontEnd) => {
          console.log('Change history plugin activated');
          const notebookApp = app as NotebookApp;
          return notebookApp.historyManager;
        }
      },
      
      // Permissions plugin
      {
        id: '@jupyter-notebook/collaboration:permissions',
        description: 'Access control for collaborative editing',
        autoStart: true,
        provides: IPermissionManager,
        activate: (app: JupyterFrontEnd) => {
          console.log('Permissions plugin activated');
          const notebookApp = app as NotebookApp;
          return notebookApp.permissionManager;
        }
      },
      
      // Comment system plugin
      {
        id: '@jupyter-notebook/collaboration:comments',
        description: 'Cell-level commenting system',
        autoStart: true,
        provides: ICommentManager,
        activate: (app: JupyterFrontEnd) => {
          console.log('Comment system plugin activated');
          const notebookApp = app as NotebookApp;
          return notebookApp.commentManager;
        }
      },
      
      // Collaboration status bar plugin
      {
        id: '@jupyter-notebook/collaboration:status-bar',
        description: 'Collaboration status indicators',
        autoStart: true,
        requires: [IUserAwareness, ICollaborationManager],
        activate: (app: JupyterFrontEnd, userAwareness: IUserAwareness, collaborationManager: ICollaborationManager) => {
          console.log('Collaboration status bar plugin activated');
          
          // Add collaboration status widget to the application shell
          if (app.shell && typeof app.shell.add === 'function') {
            // Create collaboration status widget placeholder
            // The actual widget implementation will be provided by the collaboration status bar component
            console.log('Collaboration status bar will be created by the notebook-extension plugin');
          }
          
          return { userAwareness, collaborationManager };
        }
      }
    ];

    // Register collaboration plugins with the application
    collaborationPlugins.forEach((plugin) => {
      try {
        this.registerPlugin(plugin);
      } catch (error) {
        console.error(`Failed to register collaboration plugin ${plugin.id}:`, error);
      }
    });

    console.info('Collaboration plugins registered successfully');
  }

  private _info: JupyterLab.IInfo = JupyterLab.defaultInfo;
  private _formatter = new Throttler(() => {
    Private.setFormat(this);
  }, 250);

  // Collaboration services
  private _collaborationManager: ICollaborationManager | null = null;
  private _userAwareness: UserAwareness | null = null;
  private _lockManager: CellLocking | null = null;
  private _historyManager: ChangeHistory | null = null;
  private _permissionManager: PermissionsSystem | null = null;
  private _commentManager: CommentSystem | null = null;
  private _collaborationInitialized = false;

  /**
   * Get the collaboration manager service
   */
  get collaborationManager(): ICollaborationManager | null {
    return this._collaborationManager;
  }

  /**
   * Get the user awareness service
   */
  get userAwareness(): UserAwareness | null {
    return this._userAwareness;
  }

  /**
   * Get the lock manager service
   */
  get lockManager(): CellLocking | null {
    return this._lockManager;
  }

  /**
   * Get the history manager service
   */
  get historyManager(): ChangeHistory | null {
    return this._historyManager;
  }

  /**
   * Get the permission manager service
   */
  get permissionManager(): PermissionsSystem | null {
    return this._permissionManager;
  }

  /**
   * Get the comment manager service
   */
  get commentManager(): CommentSystem | null {
    return this._commentManager;
  }

  /**
   * Check if collaboration services are initialized
   */
  get isCollaborationEnabled(): boolean {
    return this._collaborationInitialized;
  }

  /**
   * Initialize collaboration services and register them in the application service registry
   * This method is called during application startup to set up the collaboration infrastructure
   */
  private _initializeCollaborationServices(): void {
    try {
      // Check if collaboration features are enabled in configuration
      const collaborationEnabled = PageConfig.getOption('collaborationEnabled') === 'true';
      
      if (!collaborationEnabled) {
        console.info('Collaboration features are disabled in configuration');
        return;
      }

      // Initialize collaboration configuration
      const collaborationConfig = this._getCollaborationConfig();
      
      // Create and register collaboration services in proper dependency order
      this._registerCollaborationServices(collaborationConfig);

      // Mark collaboration as initialized
      this._collaborationInitialized = true;
      
      console.info('Collaboration services initialized successfully');
    } catch (error) {
      console.error('Failed to initialize collaboration services:', error);
      this._collaborationInitialized = false;
    }
  }

  /**
   * Get collaboration configuration from PageConfig
   */
  private _getCollaborationConfig(): any {
    const baseUrl = PageConfig.getOption('baseUrl') || '';
    const hubPrefix = PageConfig.getOption('hubPrefix') || '';
    const hubHost = PageConfig.getOption('hubHost') || '';
    
    const websocketUrl = `${hubHost}${hubPrefix}${baseUrl}api/collaboration/sync`;
    
    return {
      websocketUrl,
      enableOfflineMode: PageConfig.getOption('collaborationOfflineMode') === 'true',
      enablePersistence: PageConfig.getOption('collaborationPersistence') === 'true',
      enableAwareness: PageConfig.getOption('collaborationAwareness') !== 'false',
      reconnectDelay: parseInt(PageConfig.getOption('collaborationReconnectDelay') || '1000', 10),
      maxRetries: parseInt(PageConfig.getOption('collaborationMaxRetries') || '5', 10),
      heartbeatInterval: parseInt(PageConfig.getOption('collaborationHeartbeatInterval') || '30000', 10),
      lockTimeout: parseInt(PageConfig.getOption('collaborationLockTimeout') || '30000', 10),
      historyRetention: parseInt(PageConfig.getOption('collaborationHistoryRetention') || '1000', 10)
    };
  }

  /**
   * Register collaboration services with the application service registry
   */
  private _registerCollaborationServices(config: any): void {
    // Create YjsNotebookProvider instance
    const providerConfig = {
      websocketUrl: config.websocketUrl,
      roomName: 'notebook-default',
      enableOfflineMode: config.enableOfflineMode,
      enablePersistence: config.enablePersistence,
      enableAwareness: config.enableAwareness,
      reconnectDelay: config.reconnectDelay,
      maxRetries: config.maxRetries,
      heartbeatInterval: config.heartbeatInterval
    };

    // Initialize the core provider
    const yjsProvider = new YjsNotebookProvider(providerConfig);

    // Create service instances with proper dependency injection
    this._userAwareness = new UserAwareness(yjsProvider, config);
    this._lockManager = new CellLocking(yjsProvider, this._userAwareness, config);
    this._permissionManager = new PermissionsSystem(yjsProvider, this._userAwareness, config);
    this._historyManager = new ChangeHistory(yjsProvider, this._permissionManager, this._userAwareness, config);
    this._commentManager = new CommentSystem(yjsProvider, this._userAwareness, this._permissionManager, config);

    // Create collaboration manager to coordinate all services
    this._collaborationManager = {
      isEnabled: true,
      currentSession: null,
      
      async initializeSession(options: any): Promise<any> {
        try {
          // Connect the provider
          await yjsProvider.connect();
          
          // Initialize services
          await Promise.all([
            this._userAwareness?.trackUserActivity(),
            this._lockManager?.initialize?.(),
            this._historyManager?.initialize?.(),
            this._permissionManager?.initialize?.(),
            this._commentManager?.initialize?.()
          ]);

          const session = {
            id: yjsProvider.sessionId,
            notebookPath: options.notebookPath,
            users: this._userAwareness?.getActiveUsers() || [],
            connectionStatus: yjsProvider.isConnected ? 'connected' as const : 'disconnected' as const,
            
            async terminate(): Promise<void> {
              await yjsProvider.disconnect();
            }
          };

          this._collaborationManager!.currentSession = session;
          return session;
        } catch (error) {
          console.error('Failed to initialize collaboration session:', error);
          throw error;
        }
      },

      async joinSession(sessionId: string, user: any): Promise<any> {
        if (!this._collaborationManager?.currentSession) {
          throw new Error('No active collaboration session');
        }
        
        // Update user awareness with joining user
        this._userAwareness?.updateUserStatus?.(user);
        
        return this._collaborationManager.currentSession;
      },

      async leaveSession(sessionId: string): Promise<void> {
        if (this._collaborationManager?.currentSession?.id === sessionId) {
          await this._collaborationManager.currentSession.terminate();
          this._collaborationManager.currentSession = null;
        }
      }
    };

    // Register services in the application's service registry
    try {
      // Register collaboration services as singletons using token-based registration
      // Note: The JupyterLab application doesn't have a traditional service registry
      // Services are provided through the plugin system dependency injection
      console.info('Collaboration services initialized and ready for plugin dependency injection');
      
      // Services will be available through the application instance getters
      // and can be accessed by plugins that declare the appropriate tokens as dependencies
    } catch (error) {
      console.error('Failed to initialize collaboration services:', error);
      throw error;
    }
  }

  /**
   * Get collaboration service by token
   */
  getCollaborationService<T>(token: any): T | null {
    if (!this._collaborationInitialized) {
      return null;
    }

    try {
      // Map tokens to service instances
      if (token === ICollaborationManager) {
        return this._collaborationManager as T;
      } else if (token === IUserAwareness) {
        return this._userAwareness as T;
      } else if (token === ILockManager) {
        return this._lockManager as T;
      } else if (token === IHistoryManager) {
        return this._historyManager as T;
      } else if (token === IPermissionManager) {
        return this._permissionManager as T;
      } else if (token === ICommentManager) {
        return this._commentManager as T;
      }
      
      return null;
    } catch (error) {
      console.error('Failed to get collaboration service:', error);
      return null;
    }
  }

  /**
   * Enable collaboration features
   */
  async enableCollaboration(): Promise<void> {
    if (this._collaborationInitialized) {
      return;
    }

    this._initializeCollaborationServices();
  }

  /**
   * Disable collaboration features
   */
  async disableCollaboration(): Promise<void> {
    if (!this._collaborationInitialized) {
      return;
    }

    try {
      // Terminate current session if active
      if (this._collaborationManager?.currentSession) {
        await this._collaborationManager.currentSession.terminate();
      }

      // Clean up services
      this._collaborationManager = null;
      this._userAwareness = null;
      this._lockManager = null;
      this._historyManager = null;
      this._permissionManager = null;
      this._commentManager = null;

      this._collaborationInitialized = false;
      
      console.info('Collaboration services disabled');
    } catch (error) {
      console.error('Failed to disable collaboration services:', error);
    }
  }
}

/**
 * A namespace for App static items.
 */
export namespace NotebookApp {
  /**
   * The instantiation options for an App application.
   */
  export interface IOptions
    extends JupyterFrontEnd.IOptions<INotebookShell>,
      Partial<IInfo> {}

  /**
   * The information about a Jupyter Notebook application.
   */
  export interface IInfo {
    /**
     * The mime renderer extensions.
     */
    readonly mimeExtensions: IRenderMime.IExtensionModule[];

    /**
     * The information about available plugins.
     */
    readonly availablePlugins: JupyterLab.IPluginInfo[];

    /**
     * The information about collaboration features.
     */
    readonly collaborationEnabled?: boolean;

    /**
     * The collaboration configuration options.
     */
    readonly collaborationConfig?: {
      websocketUrl?: string;
      enableOfflineMode?: boolean;
      enablePersistence?: boolean;
      enableAwareness?: boolean;
      maxRetries?: number;
      reconnectDelay?: number;
      heartbeatInterval?: number;
    };
  }

  /**
   * The interface for a module that exports a plugin or plugins as
   * the default value.
   */
  export interface IPluginModule {
    /**
     * The default export.
     */
    default: JupyterFrontEndPlugin<any> | JupyterFrontEndPlugin<any>[];
  }

  /**
   * The collaboration configuration options.
   */
  export interface ICollaborationOptions {
    /**
     * Whether to enable collaboration features.
     */
    enableCollaboration?: boolean;

    /**
     * The WebSocket URL for collaboration server.
     */
    websocketUrl?: string;

    /**
     * Whether to enable offline mode with persistence.
     */
    enableOfflineMode?: boolean;

    /**
     * Whether to enable IndexedDB persistence.
     */
    enablePersistence?: boolean;

    /**
     * Whether to enable awareness protocol.
     */
    enableAwareness?: boolean;

    /**
     * Reconnection delay in milliseconds.
     */
    reconnectDelay?: number;

    /**
     * Maximum reconnection attempts.
     */
    maxRetries?: number;

    /**
     * Heartbeat interval in milliseconds.
     */
    heartbeatInterval?: number;

    /**
     * Lock timeout in milliseconds.
     */
    lockTimeout?: number;

    /**
     * History retention count.
     */
    historyRetention?: number;
  }
}

/**
 * A namespace for module-private functionality.
 */
namespace Private {
  /**
   * Media query for mobile devices.
   */
  const MOBILE_QUERY = 'only screen and (max-width: 760px)';

  /**
   * Sets the `format` of a Jupyter front-end application.
   *
   * @param app The front-end application whose format is set.
   */
  export function setFormat(app: NotebookApp): void {
    app.format = window.matchMedia(MOBILE_QUERY).matches ? 'mobile' : 'desktop';
  }
}
