(development-faq)=

# Developer FAQ

1. How do I install a prerelease version such as a beta or release candidate?

**Python 3.13 Requirement**: Starting with recent releases, Jupyter Notebook requires Python 3.13 or later. Ensure you have Python 3.13+ installed before proceeding with prerelease installation.

You can install a prerelease version of the notebook using the `--pre` flag with `pip`:

```bash
python -m pip install notebook --pre --upgrade
```

**Note**: Verify your Python version is 3.13 or later by running `python --version` before installation.

If you are using `conda` or `mamba`, you can install a prerelease version of the notebook using the alpha or beta label. For example, to install the latest alpha release with Python 3.13 compatibility, you can run:

```bash
conda install -c conda-forge -c conda-forge/label/notebook_alpha python>=3.13 notebook=7.0.0a18
```

For `mamba` users, the equivalent command is:

```bash
mamba install -c conda-forge -c conda-forge/label/notebook_alpha python>=3.13 notebook=7.0.0a18
```
