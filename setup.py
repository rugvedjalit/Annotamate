from setuptools import setup, find_packages

setup(
    name="annotamate",
    version="1.0.0",
    description="A Python package for image annotation",
    author="Rugved Jalit",
    packages=find_packages(),
    include_package_data=True,
    install_requires=[
        "customtkinter",
        "pillow",
        "tkfontawesome"
    ],
    entry_points={
        "console_scripts": [
            "annotamate=annotamate.main:main",
        ],
    },
)
