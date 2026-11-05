"""Apply the local provider adapter and run the unmodified upstream updater."""
import runpy
from provider_compat import install

install()
runpy.run_path('main.py', run_name='__main__')
