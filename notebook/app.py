"""Jupyter notebook application."""

from __future__ import annotations

import os
import re
import typing as t
from pathlib import Path

from jupyter_client.utils import ensure_async  # type:ignore[attr-defined]
from jupyter_core.application import base_aliases
from jupyter_core.paths import jupyter_config_dir
from jupyter_server.base.handlers import JupyterHandler
from jupyter_server.extension.handler import (
    ExtensionHandlerJinjaMixin,
    ExtensionHandlerMixin,
)
from jupyter_server.serverapp import flags
from jupyter_server.utils import url_escape, url_is_absolute
from jupyter_server.utils import url_path_join as ujoin
from jupyterlab.commands import (  # type:ignore[import-untyped]
    get_app_dir,
    get_user_settings_dir,
    get_workspaces_dir,
)
from jupyterlab_server import LabServerApp
from jupyterlab_server.config import (  # type:ignore[attr-defined]
    LabConfig,
    get_page_config,
    recursive_update,
)
from jupyterlab_server.handlers import _camelCase, is_url
from notebook_shim.shim import NotebookConfigShimMixin  # type:ignore[import-untyped]
from tornado import web
from traitlets import Bool, Unicode, default
from traitlets.config.loader import Config

from ._version import __version__

HERE = Path(__file__).parent.resolve()

Flags = dict[t.Union[str, tuple[str, ...]], tuple[t.Union[dict[str, t.Any], Config], str]]

app_dir = Path(get_app_dir())
version = __version__

# mypy: disable-error-code="no-untyped-call"


class NotebookBaseHandler(ExtensionHandlerJinjaMixin, ExtensionHandlerMixin, JupyterHandler):
    """The base notebook API handler."""

    @property
    def custom_css(self) -> t.Any:
        return self.settings.get("custom_css", True)

    def get_page_config(self) -> dict[str, t.Any]:
        """Get the page config."""
        config = LabConfig()
        app: JupyterNotebookApp = self.extensionapp  # type:ignore[assignment]
        base_url = self.settings.get("base_url", "/")
        page_config_data = self.settings.setdefault("page_config_data", {})
        page_config = {
            **page_config_data,
            "appVersion": version,
            "baseUrl": self.base_url,
            "terminalsAvailable": self.settings.get("terminals_available", False),
            "token": self.settings["token"],
            "fullStaticUrl": ujoin(self.base_url, "static", self.name),
            "frontendUrl": ujoin(self.base_url, "/"),
            "exposeAppInBrowser": app.expose_app_in_browser,
        }

        server_root = self.settings.get("server_root_dir", "")
        server_root = server_root.replace(os.sep, "/")
        server_root = os.path.normpath(Path(server_root).expanduser())
        try:
            # Remove the server_root from pref dir
            if self.serverapp.preferred_dir != server_root:
                page_config["preferredPath"] = "/" + os.path.relpath(
                    self.serverapp.preferred_dir, server_root
                )
            else:
                page_config["preferredPath"] = "/"
        except Exception:
            page_config["preferredPath"] = "/"

        mathjax_config = self.settings.get("mathjax_config", "TeX-AMS_HTML-full,Safe")
        # TODO Remove CDN usage.
        mathjax_url = self.settings.get(
            "mathjax_url",
            "https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.7/MathJax.js",
        )
        if not url_is_absolute(mathjax_url) and not mathjax_url.startswith(self.base_url):
            mathjax_url = ujoin(self.base_url, mathjax_url)

        page_config.setdefault("mathjaxConfig", mathjax_config)
        page_config.setdefault("fullMathjaxUrl", mathjax_url)
        page_config.setdefault("jupyterConfigDir", jupyter_config_dir())

        # Put all our config in page_config
        for name in config.trait_names():
            page_config[_camelCase(name)] = getattr(app, name)

        # Add full versions of all the urls
        for name in config.trait_names():
            if not name.endswith("_url"):
                continue
            full_name = _camelCase("full_" + name)
            full_url = getattr(app, name)
            if not is_url(full_url):
                # Relative URL will be prefixed with base_url
                full_url = ujoin(base_url, full_url)
            page_config[full_name] = full_url

        labextensions_path = app.extra_labextensions_path + app.labextensions_path
        recursive_update(
            page_config,
            get_page_config(
                labextensions_path,
                logger=self.log,
            ),
        )

        # modify page config with custom hook
        page_config_hook = self.settings.get("page_config_hook", None)
        if page_config_hook:
            page_config = page_config_hook(self, page_config)

        return page_config


class TreeHandler(NotebookBaseHandler):
    """A tree page handler."""

    @web.authenticated
    async def get(self, path: str = "") -> None:
        """
        Display appropriate page for given path.

        - A directory listing is shown if path is a directory
        - Redirected to notebook page if path is a notebook
        - Render the raw file if path is any other file
        """
        path = path.strip("/")
        cm = self.contents_manager

        if await ensure_async(cm.dir_exists(path=path)):
            if await ensure_async(cm.is_hidden(path)) and not cm.allow_hidden:
                self.log.info("Refusing to serve hidden directory, via 404 Error")
                raise web.HTTPError(404)

            # Set treePath for routing to the directory
            page_config = self.get_page_config()
            page_config["treePath"] = path

            tpl = self.render_template("tree.html", page_config=page_config)
            return self.write(tpl)
        if await ensure_async(cm.file_exists(path)):
            # it's not a directory, we have redirecting to do
            model = await ensure_async(cm.get(path, content=False))
            if model["type"] == "notebook":
                url = ujoin(self.base_url, "notebooks", url_escape(path))
            else:
                # Return raw content if file is not a notebook
                url = ujoin(self.base_url, "files", url_escape(path))
            self.log.debug("Redirecting %s to %s", self.request.path, url)
            self.redirect(url)
            return None
        raise web.HTTPError(404)


class ConsoleHandler(NotebookBaseHandler):
    """A console page handler."""

    @web.authenticated
    def get(self, path: str | None = None) -> t.Any:  # noqa: ARG002
        """Get the console page."""
        tpl = self.render_template("consoles.html", page_config=self.get_page_config())
        return self.write(tpl)


class TerminalHandler(NotebookBaseHandler):
    """A terminal page handler."""

    @web.authenticated
    def get(self, path: str | None = None) -> t.Any:  # noqa: ARG002
        """Get the terminal page."""
        tpl = self.render_template("terminals.html", page_config=self.get_page_config())
        return self.write(tpl)


class FileHandler(NotebookBaseHandler):
    """A file page handler."""

    @web.authenticated
    def get(self, path: str | None = None) -> t.Any:  # noqa: ARG002
        """Get the file page."""
        tpl = self.render_template("edit.html", page_config=self.get_page_config())
        return self.write(tpl)


class NotebookHandler(NotebookBaseHandler):
    """A notebook page handler."""

    @web.authenticated
    async def get(self, path: str = "") -> t.Any:
        """Get the notebook page. Redirect if it's a directory."""
        path = path.strip("/")
        cm = self.contents_manager

        if await ensure_async(cm.dir_exists(path=path)):
            url = ujoin(self.base_url, "tree", url_escape(path))
            self.log.debug("Redirecting %s to %s since path is a directory", self.request.path, url)
            self.redirect(url)
            return None
        tpl = self.render_template("notebooks.html", page_config=self.get_page_config())
        return self.write(tpl)


class CustomCssHandler(NotebookBaseHandler):
    """A custom CSS handler."""

    @web.authenticated
    def get(self) -> t.Any:
        """Get the custom css file."""

        self.set_header("Content-Type", "text/css")
        page_config = self.get_page_config()
        custom_css_file = f"{page_config['jupyterConfigDir']}/custom/custom.css"

        if not Path(custom_css_file).is_file():
            static_path_root = re.match("^(.*?)static", page_config["staticDir"])
            if static_path_root is not None:
                custom_dir = static_path_root.groups()[0]
                custom_css_file = f"{custom_dir}custom/custom.css"

        with Path(custom_css_file).open() as css_f:
            return self.write(css_f.read())


aliases = dict(base_aliases)


class JupyterNotebookApp(NotebookConfigShimMixin, LabServerApp):  # type:ignore[misc]
    """The notebook server extension app."""

    name = "notebook"
    app_name = "Jupyter Notebook"
    description = "Jupyter Notebook - A web-based notebook environment for interactive computing"
    version = version
    app_version = Unicode(version, help="The version of the application.")
    extension_url = "/"
    default_url = Unicode("/tree", config=True, help="The default URL to redirect to from `/`")
    file_url_prefix = "/tree"
    load_other_extensions = True
    app_dir = app_dir
    subcommands: dict[str, t.Any] = {}

    expose_app_in_browser = Bool(
        False,
        config=True,
        help="Whether to expose the global app instance to browser via window.jupyterapp",
    )

    custom_css = Bool(
        True,
        config=True,
        help="""Whether custom CSS is loaded on the page.
        Defaults to True and custom CSS is loaded.
        """,
    )

    flags: Flags = flags  # type:ignore[assignment]
    flags["expose-app-in-browser"] = (
        {"JupyterNotebookApp": {"expose_app_in_browser": True}},
        "Expose the global app instance to browser via window.jupyterapp.",
    )

    flags["custom-css"] = (
        {"JupyterNotebookApp": {"custom_css": True}},
        "Load custom CSS in template html files. Default is True",
    )

    @default("static_dir")
    def _default_static_dir(self) -> str:
        return str(HERE / "static")

    @default("templates_dir")
    def _default_templates_dir(self) -> str:
        return str(HERE / "templates")

    @default("app_settings_dir")
    def _default_app_settings_dir(self) -> str:
        return str(app_dir / "settings")

    @default("schemas_dir")
    def _default_schemas_dir(self) -> str:
        return str(app_dir / "schemas")

    @default("themes_dir")
    def _default_themes_dir(self) -> str:
        return str(app_dir / "themes")

    @default("user_settings_dir")
    def _default_user_settings_dir(self) -> str:
        return t.cast(str, get_user_settings_dir())

    @default("workspaces_dir")
    def _default_workspaces_dir(self) -> str:
        return t.cast(str, get_workspaces_dir())

    def _prepare_templates(self) -> None:
        super(LabServerApp, self)._prepare_templates()
        self.jinja2_env.globals.update(custom_css=self.custom_css)  # type:ignore[has-type]

    def server_extension_is_enabled(self, extension: str) -> bool:
        """Check if server extension is enabled."""
        if self.serverapp is None:
            return False
        try:
            extension_enabled = (
                self.serverapp.extension_manager.extensions[extension].enabled is True
            )
        except (AttributeError, KeyError, TypeError):
            extension_enabled = False
        return extension_enabled

    def initialize_handlers(self) -> None:
        """Initialize handlers."""
        assert self.serverapp is not None  # noqa: S101
        page_config = self.serverapp.web_app.settings.setdefault("page_config_data", {})
        nbclassic_enabled = self.server_extension_is_enabled("nbclassic")
        page_config["nbclassic_enabled"] = nbclassic_enabled

        # If running under JupyterHub, add more metadata.
        if "hub_prefix" in self.serverapp.tornado_settings:
            tornado_settings = self.serverapp.tornado_settings
            hub_prefix = tornado_settings["hub_prefix"]
            page_config["hubPrefix"] = hub_prefix
            page_config["hubHost"] = tornado_settings["hub_host"]
            page_config["hubUser"] = tornado_settings["user"]
            page_config["shareUrl"] = ujoin(hub_prefix, "user-redirect")
            # Assume the server_name property indicates running JupyterHub 1.0.
            if hasattr(self.serverapp, "server_name"):
                page_config["hubServerName"] = self.serverapp.server_name
            # avoid setting API token in page config
            # $JUPYTERHUB_API_TOKEN identifies the server, not the client
            # but at least make sure we don't use the token
            # if the serverapp set one
            page_config["token"] = ""

        self.handlers.append(("/tree(.*)", TreeHandler))
        self.handlers.append(("/notebooks(.*)", NotebookHandler))
        self.handlers.append(("/edit(.*)", FileHandler))
        self.handlers.append(("/consoles/(.*)", ConsoleHandler))
        self.handlers.append(("/terminals/(.*)", TerminalHandler))
        self.handlers.append(("/custom/custom.css", CustomCssHandler))
        super().initialize_handlers()

    def _register_collaboration_handlers(self) -> None:
        """Register WebSocket handlers for collaborative editing features."""
        if not self.collaboration_enabled or not COLLABORATION_HANDLERS_AVAILABLE:
            self.log.debug("Skipping collaboration handler registration")
            return

        try:
            # Register main collaboration WebSocket endpoint for CRDT synchronization
            self.handlers.append((
                r"/collaboration/?(.*)",
                CollaborationWebSocketHandler,
                {"collaboration_manager": self._collaboration_manager}
            ))

            # Register awareness WebSocket endpoint for presence and cursor tracking
            self.handlers.append((
                r"/collab/awareness/?(.*)",
                AwarenessWebSocketHandler,
                {"collaboration_manager": self._collaboration_manager}
            ))

            # Register health check endpoint for operational monitoring
            self.handlers.append((
                r"/api/collaboration/health",
                CollabHealthCheckHandler,
                {"get_health_status": self._get_collaboration_health_status}
            ))

            self.log.info("Collaboration WebSocket handlers registered successfully")
            
        except Exception as e:
            self.log.error(f"Failed to register collaboration handlers: {e}")
            self.log.info("Collaboration features may not work properly")

    def _initialize_collaboration_config(self) -> None:
        """Initialize collaboration configuration from environment variables."""
        # Set collaboration config from environment variables per Section 0.2.5
        if os.getenv("JUPYTER_COLLAB_ENABLED", "").lower() in ("true", "1", "yes"):
            self.collaboration_enabled = True
        
        if collaboration_server_url := os.getenv("JUPYTER_COLLAB_SERVER_URL"):
            self.collaboration_server_url = collaboration_server_url
        
        if redis_url := os.getenv("JUPYTER_COLLAB_REDIS_URL"):
            self.collaboration_redis_url = redis_url
        
        if storage_backend := os.getenv("JUPYTER_COLLAB_STORAGE_BACKEND"):
            self.collaboration_storage_backend = storage_backend

        # Log collaboration configuration status
        self.log.info(f"Collaboration enabled: {self.collaboration_enabled}")
        if self.collaboration_enabled:
            self.log.info(f"Collaboration server URL: {self.collaboration_server_url or 'same as notebook server'}")
            self.log.info(f"Collaboration storage backend: {self.collaboration_storage_backend}")

    async def _initialize_collaboration_manager(self) -> bool:
        """
        Initialize the collaboration manager with proper error handling.
        
        Returns:
            bool: True if collaboration was successfully initialized, False otherwise.
        """
        if not self.collaboration_enabled:
            self.log.debug("Collaboration disabled in configuration")
            return False

        if not COLLABORATION_MANAGER_AVAILABLE:
            self.log.warning(
                "Collaboration requested but CollaborationManager not available. "
                "Falling back to single-user mode."
            )
            self.collaboration_enabled = False
            return False

        try:
            # Initialize CollaborationManager with configuration
            collaboration_config = {
                "redis_url": self.collaboration_redis_url,
                "storage_backend": self.collaboration_storage_backend,
                "max_users": self.collaboration_max_users,
                "lock_timeout": self.collaboration_lock_timeout,
                "server_url": self.collaboration_server_url,
            }

            self._collaboration_manager = CollaborationManager(
                config=collaboration_config,
                log=self.log,
            )

            # Test connection to collaboration infrastructure
            await self._collaboration_manager.initialize()
            
            self.log.info("Collaboration manager initialized successfully")
            return True

        except Exception as e:
            self.log.error(f"Failed to initialize collaboration manager: {e}")
            self.log.info("Falling back to single-user mode")
            self.collaboration_enabled = False
            self._collaboration_manager = None
            return False

    def _get_collaboration_health_status(self) -> dict[str, t.Any]:
        """
        Get collaboration service health status for monitoring.
        
        Returns:
            dict: Health status information including service availability and metrics.
        """
        status = {
            "collaboration_enabled": self.collaboration_enabled,
            "collaboration_available": False,
            "active_sessions": 0,
            "total_users": 0,
            "services": {
                "collaboration_manager": "unavailable",
                "redis": "unavailable",
                "storage_backend": "unavailable",
            },
        }

        if self._collaboration_manager:
            try:
                # Get health status from collaboration manager
                manager_status = self._collaboration_manager.get_health_status()
                status.update(manager_status)
                status["collaboration_available"] = True
                status["services"]["collaboration_manager"] = "available"
                
            except Exception as e:
                self.log.warning(f"Failed to get collaboration health status: {e}")
                status["services"]["collaboration_manager"] = f"error: {str(e)}"

        return status

    def initialize(self, argv: list[str] | None = None) -> None:  # noqa: ARG002
        """
        Initialize the application with collaboration support.
        
        Subclass because the ExtensionApp.initialize() method does not take arguments.
        Enhanced to initialize collaborative editing infrastructure.
        """
        # Initialize collaboration configuration from environment variables
        self._initialize_collaboration_config()
        
        # Call parent initialization
        super().initialize()

    async def start(self) -> None:
        """
        Start the notebook server with collaboration support.
        
        Enhanced to initialize collaboration manager and provide graceful fallback.
        """
        # Initialize collaboration manager if enabled
        if self.collaboration_enabled:
            self.log.info("Initializing collaboration services...")
            
            collaboration_initialized = await self._initialize_collaboration_manager()
            
            if collaboration_initialized:
                self.log.info("Collaboration services started successfully")
            else:
                self.log.warning("Collaboration services failed to start, continuing in single-user mode")

        # Call parent start method
        await super().start()

    async def stop(self) -> None:
        """
        Stop the notebook server with proper collaboration cleanup.
        
        Enhanced to gracefully shutdown collaboration services.
        """
        if self._collaboration_manager:
            try:
                self.log.info("Shutting down collaboration services...")
                await self._collaboration_manager.shutdown()
                self.log.info("Collaboration services stopped successfully")
            except Exception as e:
                self.log.error(f"Error shutting down collaboration services: {e}")

        # Call parent stop method
        await super().stop()


main = launch_new_instance = JupyterNotebookApp.launch_instance

if __name__ == "__main__":
    main()
