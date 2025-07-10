FROM mcr.microsoft.com/devcontainers/base:jammy

ARG PIXI_VERSION=v0.42.1

# Install Python 3.13 and required development tools
RUN apt-get update && apt-get install -y \
    software-properties-common \
    && add-apt-repository ppa:deadsnakes/ppa \
    && apt-get update \
    && apt-get install -y \
        python3.13 \
        python3.13-dev \
        python3.13-venv \
        python3.13-distutils \
        python3-pip \
        build-essential \
        curl \
        ca-certificates \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.13 1 \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3.13 1 \
    && curl -sS https://bootstrap.pypa.io/get-pip.py | python3.13 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install pixi package manager
RUN curl -L -o /usr/local/bin/pixi -fsSL --compressed "https://github.com/prefix-dev/pixi/releases/download/${PIXI_VERSION}/pixi-$(uname -m)-unknown-linux-musl" \
    && chmod +x /usr/local/bin/pixi \
    && pixi info

# set some user and workdir settings to work nicely with vscode
USER vscode
WORKDIR /home/vscode

# Configure environment to use Python 3.13
ENV PYTHON_VERSION=3.13
ENV PYTHONPATH=/usr/local/lib/python3.13/site-packages:$PYTHONPATH
ENV PATH=/usr/local/bin:$PATH

# Set up bash completion and environment for vscode user
RUN echo 'eval "$(pixi completion -s bash)"' >> /home/vscode/.bashrc \
    && echo 'export PYTHON_VERSION=3.13' >> /home/vscode/.bashrc \
    && echo 'export PYTHONPATH=/usr/local/lib/python3.13/site-packages:$PYTHONPATH' >> /home/vscode/.bashrc \
    && echo 'alias python=python3.13' >> /home/vscode/.bashrc \
    && echo 'alias pip=pip3' >> /home/vscode/.bashrc
