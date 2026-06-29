# Shim for tooling (conda's load_setup_py_data, legacy invocations) that expects
# a setup.py. The real build configuration lives in pyproject.toml; the version
# is derived from git tags by setuptools_scm.
from setuptools import setup

setup()
