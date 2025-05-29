// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { JupyterFrontEnd } from '@jupyterlab/application';
import { DocumentRegistry } from '@jupyterlab/docregistry';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';

import { find } from '@lumino/algorithm';
import { JSONExt, PromiseDelegate, Token } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';

import {
  BoxLayout,
  FocusTracker,
  Panel,
  SplitPanel,
  TabPanel,
  Widget,
} from '@lumino/widgets';
import { PanelHandler, SidePanelHandler } from './panelhandler';
import { TabPanelSvg } from '@jupyterlab/ui-components';

// Collaboration imports for enhanced shell functionality
export interface IYjsNotebookProvider {
  awareness: any;
  locks: any;
  history: any;
  permissions: any;
  comments: any;
  isConnected: boolean;
  connectionStatus: 'connected' | 'disconnected' | 'connecting' | 'error';
}

export interface ICollaborationStatus {
  provider?: IYjsNotebookProvider;
  activeUsers: number;
  isCollaborating: boolean;
  hasPermission: boolean;
  syncStatus: 'synced' | 'syncing' | 'offline' | 'error';
}

/**
 * The Jupyter Notebook application shell token.
 */
export const INotebookShell = new Token<INotebookShell>(
  '@jupyter-notebook/application:INotebookShell'
);

/**
 * The Jupyter Notebook application shell interface.
 */
export interface INotebookShell extends NotebookShell {}

/**
 * The namespace for INotebookShell type information.
 */
export namespace INotebookShell {
  /**
   * The areas of the application shell where widgets can reside.
   * Enhanced with collaboration-specific namespaced regions for proper
   * scoping and isolation of collaboration widgets within appropriate UI zones.
   */
  export type Area = 
    | 'main' 
    | 'top' 
    | 'menu' 
    | 'left' 
    | 'right' 
    | 'down'
    | 'collaboration-top'      // Hosts the Collaboration Bar in the top area
    | 'collaboration-sidebar'  // Contains History Viewer and Permissions Dialog in the right sidebar
    | 'cell-overlay';          // Manages cell-level UI elements like comment indicators and lock status

  /**
   * Widget position
   */
  export interface IWidgetPosition {
    /**
     * Widget area
     */
    area?: Area;
    /**
     * Widget opening options
     */
    options?: DocumentRegistry.IOpenOptions;
  }

  /**
   * Mapping of widget type identifier and their user customized position
   */
  export interface IUserLayout {
    /**
     * Widget customized position
     */
    [k: string]: IWidgetPosition;
  }

  /**
   * Collaboration-specific widget options for enhanced add() semantics
   */
  export interface ICollaborationOptions extends DocumentRegistry.IOpenOptions {
    /**
     * The collaboration namespace for proper widget scoping
     */
    namespace?: 'collaboration-top' | 'collaboration-sidebar' | 'cell-overlay';
    
    /**
     * Whether this widget requires collaboration provider integration
     */
    requiresCollaboration?: boolean;
    
    /**
     * Responsive layout preferences for the widget
     */
    responsive?: {
      mobile?: boolean;
      desktop?: boolean;
      breakpoint?: number;
    };
  }
}

/**
 * The default rank for ranked panels.
 */
const DEFAULT_RANK = 900;

/**
 * The application shell with enhanced collaboration support.
 * Provides namespaced regions for collaboration features through enhanced add() semantics
 * and integration with YjsNotebookProvider for real-time document synchronization.
 */
export class NotebookShell extends Widget implements JupyterFrontEnd.IShell {
  constructor() {
    super();
    this.id = 'main';
    this._userLayout = {};
    this._collaborationStatus = {
      activeUsers: 0,
      isCollaborating: false,
      hasPermission: true,
      syncStatus: 'offline'
    };

    this._topHandler = new PanelHandler();
    this._menuHandler = new PanelHandler();
    this._leftHandler = new SidePanelHandler('left');
    this._rightHandler = new SidePanelHandler('right');
    this._main = new Panel();
    
    // Enhanced panel wrappers with collaboration support
    const topWrapper = (this._topWrapper = new Panel());
    const menuWrapper = (this._menuWrapper = new Panel());

    // Collaboration-specific panels for namespaced widget management
    this._collaborationTopPanel = new Panel();
    this._collaborationSidebarPanel = new Panel(); 
    this._cellOverlayPanel = new Panel();

    this._topHandler.panel.id = 'top-panel';
    this._topHandler.panel.node.setAttribute('role', 'banner');
    this._menuHandler.panel.id = 'menu-panel';
    this._menuHandler.panel.node.setAttribute('role', 'navigation');
    this._main.id = 'main-panel';
    this._main.node.setAttribute('role', 'main');

    // Configure collaboration panels
    this._collaborationTopPanel.id = 'collaboration-top-panel';
    this._collaborationTopPanel.addClass('jp-collaboration-top');
    this._collaborationSidebarPanel.id = 'collaboration-sidebar-panel';
    this._collaborationSidebarPanel.addClass('jp-collaboration-sidebar');
    this._cellOverlayPanel.id = 'cell-overlay-panel';
    this._cellOverlayPanel.addClass('jp-cell-overlay');

    this._spacer_top = new Widget();
    this._spacer_top.id = 'spacer-widget-top';
    this._spacer_bottom = new Widget();
    this._spacer_bottom.id = 'spacer-widget-bottom';

    // create wrappers around the top and menu areas
    topWrapper.id = 'top-panel-wrapper';
    topWrapper.addWidget(this._topHandler.panel);
    // Add collaboration bar to top area wrapper
    topWrapper.addWidget(this._collaborationTopPanel);

    menuWrapper.id = 'menu-panel-wrapper';
    menuWrapper.addWidget(this._menuHandler.panel);

    const rootLayout = new BoxLayout();
    const leftHandler = this._leftHandler;
    const rightHandler = this._rightHandler;

    leftHandler.panel.id = 'jp-left-stack';
    leftHandler.panel.node.setAttribute('role', 'complementary');
    rightHandler.panel.id = 'jp-right-stack';
    rightHandler.panel.node.setAttribute('role', 'complementary');

    // Add collaboration sidebar to right handler
    rightHandler.panel.addWidget(this._collaborationSidebarPanel);

    // Hide the side panels by default.
    leftHandler.hide();
    rightHandler.hide();

    const middleLayout = new BoxLayout({
      spacing: 0,
      direction: 'top-to-bottom',
    });
    BoxLayout.setStretch(this._topWrapper, 0);
    BoxLayout.setStretch(this._menuWrapper, 0);
    BoxLayout.setStretch(this._main, 1);

    const middlePanel = new Panel({ layout: middleLayout });
    middlePanel.addWidget(this._topWrapper);
    middlePanel.addWidget(this._menuWrapper);
    middlePanel.addWidget(this._spacer_top);
    middlePanel.addWidget(this._main);
    middlePanel.addWidget(this._spacer_bottom);
    middlePanel.layout = middleLayout;

    // Add cell overlay panel to main area for cell-level UI elements
    this._main.addWidget(this._cellOverlayPanel);

    const vsplitPanel = new SplitPanel();
    vsplitPanel.id = 'jp-main-vsplit-panel';
    vsplitPanel.spacing = 1;
    vsplitPanel.orientation = 'vertical';
    SplitPanel.setStretch(vsplitPanel, 1);

    const downPanel = new TabPanelSvg({
      tabsMovable: true,
    });
    this._downPanel = downPanel;
    this._downPanel.id = 'jp-down-stack';

    // TODO: Consider storing this as an attribute this._hsplitPanel if saving/restoring layout needed
    const hsplitPanel = new SplitPanel();
    hsplitPanel.id = 'main-split-panel';
    hsplitPanel.spacing = 1;
    BoxLayout.setStretch(hsplitPanel, 1);

    SplitPanel.setStretch(leftHandler.panel, 0);
    SplitPanel.setStretch(rightHandler.panel, 0);
    SplitPanel.setStretch(middlePanel, 1);

    hsplitPanel.addWidget(leftHandler.panel);
    hsplitPanel.addWidget(middlePanel);
    hsplitPanel.addWidget(rightHandler.panel);

    // Use relative sizing to set the width of the side panels.
    // This will still respect the min-size of children widget in the stacked
    // panel.
    hsplitPanel.setRelativeSizes([1, 2.5, 1]);

    vsplitPanel.addWidget(hsplitPanel);
    vsplitPanel.addWidget(downPanel);

    rootLayout.spacing = 0;
    rootLayout.addWidget(vsplitPanel);

    // initially hiding the down panel
    this._downPanel.hide();

    // Connect down panel change listeners
    this._downPanel.tabBar.tabMoved.connect(this._onTabPanelChanged, this);
    this._downPanel.stackedPanel.widgetRemoved.connect(
      this._onTabPanelChanged,
      this
    );

    this.layout = rootLayout;

    // Added Skip to Main Link
    const skipLinkWidgetHandler = (this._skipLinkWidgetHandler =
      new Private.SkipLinkWidgetHandler(this));

    this.add(skipLinkWidgetHandler.skipLinkWidget, 'top', { rank: 0 });
    this._skipLinkWidgetHandler.show();

    // Initialize responsive layout support
    this._initializeResponsiveLayout();
  }

  /**
   * A signal emitted when the current widget changes.
   */
  get currentChanged(): ISignal<
    JupyterFrontEnd.IShell,
    FocusTracker.IChangedArgs<Widget>
  > {
    return this._currentChanged;
  }

  /**
   * The current widget in the shell's main area.
   */
  get currentWidget(): Widget | null {
    return this._main.widgets[0] ?? null;
  }

  /**
   * Get the collaboration status for the current session.
   * Provides real-time information about collaboration state including
   * active users, sync status, and provider connectivity.
   */
  get collaborationStatus(): ICollaborationStatus {
    return { ...this._collaborationStatus };
  }

  /**
   * Get the YjsNotebookProvider for real-time collaboration integration.
   * Returns null if collaboration is not active or configured.
   */
  get collaborationProvider(): IYjsNotebookProvider | null {
    return this._collaborationStatus.provider || null;
  }

  /**
   * Get the top area wrapper panel
   */
  get top(): Widget {
    return this._topWrapper;
  }

  /**
   * Get the menu area wrapper panel
   */
  get menu(): Widget {
    return this._menuWrapper;
  }

  /**
   * Get the collaboration top panel for hosting collaboration bar
   */
  get collaborationTop(): Panel {
    return this._collaborationTopPanel;
  }

  /**
   * Get the collaboration sidebar panel for history viewer and permissions dialog
   */
  get collaborationSidebar(): Panel {
    return this._collaborationSidebarPanel;
  }

  /**
   * Get the cell overlay panel for cell-level UI elements
   */
  get cellOverlay(): Panel {
    return this._cellOverlayPanel;
  }

  /**
   * Get the left area handler
   */
  get leftHandler(): SidePanelHandler {
    return this._leftHandler;
  }

  /**
   * Get the right area handler
   */
  get rightHandler(): SidePanelHandler {
    return this._rightHandler;
  }

  /**
   * Is the left sidebar visible?
   */
  get leftCollapsed(): boolean {
    return !(this._leftHandler.isVisible && this._leftHandler.panel.isVisible);
  }

  /**
   * Is the right sidebar visible?
   */
  get rightCollapsed(): boolean {
    return !(
      this._rightHandler.isVisible && this._rightHandler.panel.isVisible
    );
  }

  /**
   * Promise that resolves when the main widget is loaded
   */
  get restored(): Promise<void> {
    return this._mainWidgetLoaded.promise;
  }

  /**
   * Getter and setter for the translator.
   */
  get translator(): ITranslator {
    return this._translator ?? nullTranslator;
  }
  set translator(value: ITranslator) {
    if (value !== this._translator) {
      this._translator = value;
      const trans = value.load('notebook');
      this._leftHandler.closeButton.title = trans.__(
        'Collapse %1 side panel',
        this._leftHandler.area
      );
      this._rightHandler.closeButton.title = trans.__(
        'Collapse %1 side panel',
        this._rightHandler.area
      );
    }
  }

  /**
   * User custom shell layout.
   */
  get userLayout() {
    return JSONExt.deepCopy(this._userLayout as any);
  }

  /**
   * Set the collaboration provider for real-time document synchronization.
   * Integrates with YjsNotebookProvider and collaboration modules.
   */
  setCollaborationProvider(provider: IYjsNotebookProvider | null): void {
    if (this._collaborationStatus.provider !== provider) {
      // Disconnect from previous provider if any
      if (this._collaborationStatus.provider) {
        this._disconnectCollaborationProvider();
      }

      this._collaborationStatus.provider = provider;
      
      if (provider) {
        this._connectCollaborationProvider(provider);
      } else {
        this._collaborationStatus.isCollaborating = false;
        this._collaborationStatus.syncStatus = 'offline';
        this._collaborationStatus.activeUsers = 0;
      }

      // Emit collaboration status change signal
      this._collaborationStatusChanged.emit(this._collaborationStatus);
    }
  }

  /**
   * Signal emitted when collaboration status changes.
   */
  get collaborationStatusChanged(): ISignal<NotebookShell, ICollaborationStatus> {
    return this._collaborationStatusChanged;
  }

  /**
   * Activate a widget in its area.
   */
  activateById(id: string): void {
    // Search all areas that can have widgets for this widget, starting with main.
    const areas: INotebookShell.Area[] = [
      'main', 'top', 'left', 'right', 'menu', 'down',
      'collaboration-top', 'collaboration-sidebar', 'cell-overlay'
    ];
    
    for (const area of areas) {
      const widget = find(
        this.widgets(area),
        (w) => w.id === id
      );
      if (widget) {
        if (area === 'left') {
          this.expandLeft(id);
        } else if (area === 'right') {
          this.expandRight(id);
        } else if (area === 'down') {
          this._downPanel.show();
          widget.activate();
        } else if (area === 'collaboration-sidebar') {
          // Special handling for collaboration sidebar widgets
          this.expandRight(); // Ensure right sidebar is visible
          widget.activate();
        } else {
          widget.activate();
        }
        break;
      }
    }
  }

  /**
   * Add a widget to the application shell with enhanced collaboration support.
   * Supports namespaced regions for collaboration features and proper scoping.
   *
   * @param widget - The widget being added.
   *
   * @param area - Optional region in the shell into which the widget should
   * be added. Enhanced to support collaboration namespaces.
   *
   * @param options - Optional open options with collaboration-specific enhancements.
   *
   */
  add(
    widget: Widget,
    area?: INotebookShell.Area,
    options?: DocumentRegistry.IOpenOptions | INotebookShell.ICollaborationOptions
  ): void {
    let userPosition: INotebookShell.IWidgetPosition | undefined;
    if (options?.type && this._userLayout[options.type]) {
      userPosition = this._userLayout[options.type];
    } else {
      userPosition = this._userLayout[widget.id];
    }

    area = userPosition?.area ?? area;
    options =
      options || userPosition?.options
        ? {
            ...options,
            ...userPosition?.options,
          }
        : undefined;

    const rank = options?.rank ?? DEFAULT_RANK;
    const collabOptions = options as INotebookShell.ICollaborationOptions;

    // Enhanced collaboration widget handling
    if (collabOptions?.requiresCollaboration && !this._collaborationStatus.isCollaborating) {
      // Widget requires collaboration but collaboration is not active
      console.warn(`Widget ${widget.id} requires collaboration but collaboration is not active`);
      return;
    }

    // Apply responsive layout preferences if specified
    if (collabOptions?.responsive) {
      this._applyResponsiveLayout(widget, collabOptions.responsive);
    }

    // Handle collaboration namespaces with proper scoping and isolation
    switch (area) {
      case 'collaboration-top':
        // Collaboration Bar and presence indicators in top area
        widget.addClass('jp-collaboration-widget');
        widget.addClass('jp-collaboration-top-widget');
        return this._addToCollaborationTop(widget, rank);
        
      case 'collaboration-sidebar':
        // History Viewer and Permissions Dialog in right sidebar
        widget.addClass('jp-collaboration-widget');
        widget.addClass('jp-collaboration-sidebar-widget');
        return this._addToCollaborationSidebar(widget, rank);
        
      case 'cell-overlay':
        // Cell-level UI elements like comment indicators and lock status
        widget.addClass('jp-collaboration-widget');
        widget.addClass('jp-cell-overlay-widget');
        return this._addToCellOverlay(widget, rank);
        
      case 'top':
        return this._topHandler.addWidget(widget, rank);
        
      case 'menu':
        return this._menuHandler.addWidget(widget, rank);
        
      case 'main':
      case undefined: {
        if (this._main.widgets.length > 1) {
          // Allow cell overlay widgets in main area alongside primary widget
          const isOverlay = widget.hasClass('jp-cell-overlay-widget');
          if (!isOverlay) {
            // do not add non-overlay widgets if there is already a primary widget
            return;
          }
        }
        const previousWidget = this.currentWidget;
        this._main.addWidget(widget);
        this._main.update();
        
        // Only emit change signal for primary widgets, not overlays
        if (!widget.hasClass('jp-cell-overlay-widget')) {
          this._currentChanged.emit({
            newValue: widget,
            oldValue: previousWidget,
          });
          this._mainWidgetLoaded.resolve();
        }
        break;
      }
      case 'left':
        return this._leftHandler.addWidget(widget, rank);
        
      case 'right':
        return this._rightHandler.addWidget(widget, rank);
        
      case 'down':
        return this._downPanel.addWidget(widget);
        
      default:
        console.warn(`Cannot add widget to area: ${area}`);
    }
  }

  /**
   * Collapse the top area and the spacer to make the view more compact.
   */
  collapseTop(): void {
    this._topWrapper.setHidden(true);
    this._spacer_top.setHidden(true);
  }

  /**
   * Expand the top area to show the header and the spacer.
   */
  expandTop(): void {
    this._topWrapper.setHidden(false);
    this._spacer_top.setHidden(false);
  }

  /**
   * Return the list of widgets for the given area, including collaboration namespaces.
   *
   * @param area The area
   */
  *widgets(area: INotebookShell.Area): IterableIterator<Widget> {
    switch (area ?? 'main') {
      case 'top':
        yield* this._topHandler.panel.widgets;
        return;
      case 'menu':
        yield* this._menuHandler.panel.widgets;
        return;
      case 'main':
        yield* this._main.widgets;
        return;
      case 'left':
        yield* this._leftHandler.widgets;
        return;
      case 'right':
        yield* this._rightHandler.widgets;
        return;
      case 'down':
        yield* this._downPanel.widgets;
        return;
      case 'collaboration-top':
        yield* this._collaborationTopPanel.widgets;
        return;
      case 'collaboration-sidebar':
        yield* this._collaborationSidebarPanel.widgets;
        return;
      case 'cell-overlay':
        yield* this._cellOverlayPanel.widgets;
        return;
      default:
        console.error(`This shell has no area called "${area}"`);
        return;
    }
  }

  /**
   * Expand the left panel to show the sidebar with its widget.
   */
  expandLeft(id?: string): void {
    this._leftHandler.panel.show();
    this._leftHandler.expand(id); // Show the current widget, if any
  }

  /**
   * Collapse the left panel
   */
  collapseLeft(): void {
    this._leftHandler.collapse();
    this._leftHandler.panel.hide();
  }

  /**
   * Expand the right panel to show the sidebar with its widget.
   */
  expandRight(id?: string): void {
    this._rightHandler.panel.show();
    this._rightHandler.expand(id); // Show the current widget, if any
  }

  /**
   * Collapse the right panel
   */
  collapseRight(): void {
    this._rightHandler.collapse();
    this._rightHandler.panel.hide();
  }

  /**
   * Restore the layout state and configuration for the application shell.
   */
  async restoreLayout(
    configuration: INotebookShell.IUserLayout
  ): Promise<void> {
    this._userLayout = configuration;
  }

  /**
   * Update collaboration status and emit change signal.
   * Used internally for real-time collaboration state management.
   */
  updateCollaborationStatus(status: Partial<ICollaborationStatus>): void {
    const updated = { ...this._collaborationStatus, ...status };
    if (JSON.stringify(updated) !== JSON.stringify(this._collaborationStatus)) {
      this._collaborationStatus = updated;
      this._collaborationStatusChanged.emit(this._collaborationStatus);
    }
  }

  /**
   * Add widget to collaboration top area with proper isolation.
   * Private method for managing collaboration-top namespace widgets.
   */
  private _addToCollaborationTop(widget: Widget, rank: number): void {
    // Remove widget from parent if it has one
    widget.parent = null;
    
    // Add to collaboration top panel with rank-based ordering
    const items = Array.from(this._collaborationTopPanel.widgets)
      .map(w => ({ widget: w, rank: (w as any)._rank || DEFAULT_RANK }))
      .concat([{ widget, rank }])
      .sort((a, b) => a.rank - b.rank);
    
    // Clear and re-add all widgets in order
    while (this._collaborationTopPanel.widgets.length > 0) {
      this._collaborationTopPanel.widgets[0].parent = null;
    }
    
    items.forEach(item => {
      (item.widget as any)._rank = item.rank;
      this._collaborationTopPanel.addWidget(item.widget);
    });
  }

  /**
   * Add widget to collaboration sidebar area with proper isolation.
   * Private method for managing collaboration-sidebar namespace widgets.
   */
  private _addToCollaborationSidebar(widget: Widget, rank: number): void {
    // Remove widget from parent if it has one
    widget.parent = null;
    
    // Add to collaboration sidebar panel with rank-based ordering
    const items = Array.from(this._collaborationSidebarPanel.widgets)
      .map(w => ({ widget: w, rank: (w as any)._rank || DEFAULT_RANK }))
      .concat([{ widget, rank }])
      .sort((a, b) => a.rank - b.rank);
    
    // Clear and re-add all widgets in order
    while (this._collaborationSidebarPanel.widgets.length > 0) {
      this._collaborationSidebarPanel.widgets[0].parent = null;
    }
    
    items.forEach(item => {
      (item.widget as any)._rank = item.rank;
      this._collaborationSidebarPanel.addWidget(item.widget);
    });

    // Ensure right sidebar is visible when collaboration widgets are added
    if (!this._rightHandler.isVisible) {
      this._rightHandler.show();
    }
  }

  /**
   * Add widget to cell overlay area with proper positioning.
   * Private method for managing cell-overlay namespace widgets.
   */
  private _addToCellOverlay(widget: Widget, rank: number): void {
    // Remove widget from parent if it has one
    widget.parent = null;
    
    // Set up overlay positioning
    widget.addClass('jp-cell-overlay-positioned');
    
    // Add to cell overlay panel with rank-based z-index
    (widget.node.style as any).zIndex = rank.toString();
    (widget as any)._rank = rank;
    
    this._cellOverlayPanel.addWidget(widget);
  }

  /**
   * Connect to collaboration provider and set up event listeners.
   * Private method for YjsNotebookProvider integration.
   */
  private _connectCollaborationProvider(provider: IYjsNotebookProvider): void {
    this._collaborationStatus.isCollaborating = true;
    this._collaborationStatus.syncStatus = provider.isConnected ? 'synced' : 'connecting';

    // Update connection status based on provider state
    const updateConnectionStatus = () => {
      this.updateCollaborationStatus({
        syncStatus: provider.isConnected ? 'synced' : 'offline'
      });
    };

    // Monitor provider connection changes
    if (provider.awareness) {
      // Listen for awareness changes to update active user count
      const updateActiveUsers = () => {
        const awarenessStates = provider.awareness.getStates();
        this.updateCollaborationStatus({
          activeUsers: awarenessStates.size - 1 // Exclude current user
        });
      };
      
      // Set up awareness listeners (pseudo-code since actual implementation would depend on Yjs API)
      if (typeof provider.awareness.on === 'function') {
        provider.awareness.on('change', updateActiveUsers);
        provider.awareness.on('update', updateActiveUsers);
      }
    }

    // Initial status update
    updateConnectionStatus();
  }

  /**
   * Disconnect from collaboration provider and clean up.
   * Private method for provider cleanup.
   */
  private _disconnectCollaborationProvider(): void {
    // Clean up any provider event listeners here
    // Implementation would depend on actual YjsNotebookProvider API
    
    this._collaborationStatus.isCollaborating = false;
    this._collaborationStatus.syncStatus = 'offline';
    this._collaborationStatus.activeUsers = 0;
  }

  /**
   * Initialize responsive layout support for collaboration UI components.
   * Private method for setting up responsive behavior.
   */
  private _initializeResponsiveLayout(): void {
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    
    const handleResponsiveChange = (e: MediaQueryListEvent | MediaQueryList) => {
      const isMobile = e.matches;
      
      // Apply responsive classes to collaboration areas
      this._collaborationTopPanel.toggleClass('jp-collaboration-mobile', isMobile);
      this._collaborationSidebarPanel.toggleClass('jp-collaboration-mobile', isMobile);
      this._cellOverlayPanel.toggleClass('jp-collaboration-mobile', isMobile);
      
      // Emit responsive layout change signal
      this._responsiveLayoutChanged.emit({ isMobile, breakpoint: 768 });
    };

    // Set up responsive listener
    mediaQuery.addListener(handleResponsiveChange);
    handleResponsiveChange(mediaQuery); // Initial call
    
    // Store reference for cleanup
    this._mediaQuery = mediaQuery;
    this._responsiveHandler = handleResponsiveChange;
  }

  /**
   * Apply responsive layout preferences to a widget.
   * Private method for responsive widget configuration.
   */
  private _applyResponsiveLayout(
    widget: Widget, 
    responsive: NonNullable<INotebookShell.ICollaborationOptions['responsive']>
  ): void {
    if (responsive.mobile !== undefined) {
      widget.toggleClass('jp-responsive-mobile', responsive.mobile);
    }
    if (responsive.desktop !== undefined) {
      widget.toggleClass('jp-responsive-desktop', responsive.desktop);
    }
    if (responsive.breakpoint !== undefined) {
      (widget as any)._responsiveBreakpoint = responsive.breakpoint;
    }
  }

  /**
   * Handle a change on the down panel widgets
   */
  private _onTabPanelChanged(): void {
    if (this._downPanel.stackedPanel.widgets.length === 0) {
      this._downPanel.hide();
    }
  }

  private _topWrapper: Panel;
  private _topHandler: PanelHandler;
  private _menuWrapper: Panel;
  private _menuHandler: PanelHandler;
  private _leftHandler: SidePanelHandler;
  private _rightHandler: SidePanelHandler;
  private _spacer_top: Widget;
  private _spacer_bottom: Widget;
  private _skipLinkWidgetHandler: Private.SkipLinkWidgetHandler;
  private _main: Panel;
  private _downPanel: TabPanel;
  
  // Enhanced collaboration support
  private _collaborationTopPanel: Panel;
  private _collaborationSidebarPanel: Panel;
  private _cellOverlayPanel: Panel;
  private _collaborationStatus: ICollaborationStatus;
  private _collaborationStatusChanged = new Signal<this, ICollaborationStatus>(this);
  private _responsiveLayoutChanged = new Signal<this, { isMobile: boolean; breakpoint: number }>(this);
  
  // Responsive layout support
  private _mediaQuery?: MediaQueryList;
  private _responsiveHandler?: (e: MediaQueryListEvent | MediaQueryList) => void;
  
  private _translator: ITranslator = nullTranslator;
  private _currentChanged = new Signal<this, FocusTracker.IChangedArgs<Widget>>(
    this
  );
  private _mainWidgetLoaded = new PromiseDelegate<void>();
  private _userLayout: INotebookShell.IUserLayout;
}

/**
 * Enhanced Private namespace with collaboration support.
 */
export namespace Private {
  /**
   * SkipLinkWidgetHandler with collaboration awareness.
   */
  export class SkipLinkWidgetHandler {
    /**
     * Construct a new skipLink widget handler.
     */
    constructor(shell: INotebookShell) {
      this._shell = shell;
      const skipLinkWidget = (this._skipLinkWidget = new Widget());
      const skipToMain = document.createElement('a');
      skipToMain.href = '#first-cell';
      skipToMain.tabIndex = 1;
      skipToMain.text = 'Skip to Main';
      skipToMain.className = 'skip-link';
      skipToMain.addEventListener('click', this);
      skipLinkWidget.addClass('jp-skiplink');
      skipLinkWidget.id = 'jp-skiplink';
      skipLinkWidget.node.appendChild(skipToMain);

      // Add collaboration-aware skip link if collaboration is active
      this._setupCollaborationSkipLinks();
      
      // Listen for collaboration status changes
      this._shell.collaborationStatusChanged.connect(this._onCollaborationStatusChanged, this);
    }

    handleEvent(event: Event): void {
      switch (event.type) {
        case 'click':
          const target = event.target as HTMLElement;
          if (target.getAttribute('href') === '#first-cell') {
            this._focusMain();
          } else if (target.getAttribute('href') === '#collaboration-bar') {
            this._focusCollaborationBar();
          } else if (target.getAttribute('href') === '#collaboration-sidebar') {
            this._focusCollaborationSidebar();
          }
          break;
      }
    }

    /**
     * Focus the main content area (first cell).
     */
    private _focusMain() {
      const input = document.querySelector(
        '#main-panel .jp-InputArea-editor'
      ) as HTMLInputElement;
      if (input) {
        input.tabIndex = 1;
        input.focus();
      }
    }

    /**
     * Focus the collaboration bar if present.
     */
    private _focusCollaborationBar() {
      const collabBar = document.querySelector(
        '#collaboration-top-panel .jp-collaboration-bar'
      ) as HTMLElement;
      if (collabBar) {
        collabBar.tabIndex = 1;
        collabBar.focus();
      }
    }

    /**
     * Focus the collaboration sidebar if present.
     */
    private _focusCollaborationSidebar() {
      const collabSidebar = document.querySelector(
        '#collaboration-sidebar-panel'
      ) as HTMLElement;
      if (collabSidebar) {
        collabSidebar.tabIndex = 1;
        collabSidebar.focus();
      }
    }

    /**
     * Set up collaboration-specific skip links.
     */
    private _setupCollaborationSkipLinks(): void {
      if (this._shell.collaborationStatus.isCollaborating) {
        // Add skip to collaboration bar link
        const skipToCollabBar = document.createElement('a');
        skipToCollabBar.href = '#collaboration-bar';
        skipToCollabBar.tabIndex = 2;
        skipToCollabBar.text = 'Skip to Collaboration Bar';
        skipToCollabBar.className = 'skip-link collaboration-skip';
        skipToCollabBar.addEventListener('click', this);
        this._skipLinkWidget.node.appendChild(skipToCollabBar);

        // Add skip to collaboration sidebar link
        const skipToCollabSidebar = document.createElement('a');
        skipToCollabSidebar.href = '#collaboration-sidebar';
        skipToCollabSidebar.tabIndex = 3;
        skipToCollabSidebar.text = 'Skip to Collaboration Tools';
        skipToCollabSidebar.className = 'skip-link collaboration-skip';
        skipToCollabSidebar.addEventListener('click', this);
        this._skipLinkWidget.node.appendChild(skipToCollabSidebar);
      }
    }

    /**
     * Handle collaboration status changes.
     */
    private _onCollaborationStatusChanged(
      sender: INotebookShell,
      status: ICollaborationStatus
    ): void {
      // Remove existing collaboration skip links
      const existingLinks = this._skipLinkWidget.node.querySelectorAll('.collaboration-skip');
      existingLinks.forEach(link => link.remove());

      // Re-setup if collaboration is active
      if (status.isCollaborating) {
        this._setupCollaborationSkipLinks();
      }
    }

    /**
     * Get the input element managed by the handler.
     */
    get skipLinkWidget(): Widget {
      return this._skipLinkWidget;
    }

    /**
     * Dispose of the handler and the resources it holds.
     */
    dispose(): void {
      if (this.isDisposed) {
        return;
      }
      this._isDisposed = true;
      
      // Disconnect collaboration status listener
      this._shell.collaborationStatusChanged.disconnect(this._onCollaborationStatusChanged, this);
      
      // Remove event listeners
      this._skipLinkWidget.node.removeEventListener('click', this);
      const collaborationLinks = this._skipLinkWidget.node.querySelectorAll('.collaboration-skip');
      collaborationLinks.forEach(link => link.removeEventListener('click', this));
      
      this._skipLinkWidget.dispose();
    }

    /**
     * Hide the skipLink widget.
     */
    hide(): void {
      this._skipLinkWidget.hide();
    }

    /**
     * Show the skipLink widget.
     */
    show(): void {
      this._skipLinkWidget.show();
    }

    /**
     * Test whether the handler has been disposed.
     */
    get isDisposed(): boolean {
      return this._isDisposed;
    }

    private _shell: INotebookShell;
    private _skipLinkWidget: Widget;
    private _isDisposed = false;
  }
}