#!/bin/zsh
echo "Compiling Protos for Protobuffers"
echo "allow to execute helper script"
chmod u+x $0:a:h/node_modules/protobufjs/cli/bin/pbjs
echo "compile..."
$0:a:h/node_modules/protobufjs/cli/bin/pbjs -t static-module -w commonjs -o $0:a:h/bus/protos/BusMessages.js $0:a:h/bus/protos/BusMessages.proto
echo "...complete"
