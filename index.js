/*
 * Copyright (c) 2020 ZHdK - Martin Froehlich.
 *
 * See LICENSE for more information
 */

const tBusClient = require('./lib/TBusClient')
const tBusServer = require('./lib/TBusServer')

// Expose Client and Server
module.exports.Client = tBusClient
module.exports.Server = tBusServer
