{
  "targets": [{
    "target_name": "ghostty_native",
    "sources": ["src/addon.cc"],
    "include_dirs": ["<(module_root_dir)/native/libghostty-vt/include"],
    "libraries": ["<(module_root_dir)/native/libghostty-vt/lib/libghostty-vt.a"],
    "conditions": [["OS=='linux'", {"libraries": ["-lutil", "-lpthread"], "cflags_cc": ["-O3", "-std=c++17"]}]],
    "xcode_settings": {
      "OTHER_CPLUSPLUSFLAGS": ["-O3", "-std=c++17"],
      "MACOSX_DEPLOYMENT_TARGET": "13.0"
    }
  }]
}
