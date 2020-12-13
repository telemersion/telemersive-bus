/*
 * Copyright (c) 2020 ZHdK - Martin Froehlich.
 *
 * See LICENSE for more information
 */

const TBusClient = require('./lib/TBusClient')
const TBusManager = require('./lib/TBusManager')

// Expose Client and Server
module.exports.Client = TBusClient
module.exports.Server = TBusManager
