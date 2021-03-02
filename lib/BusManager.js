const short = require('short-uuid');
const sha1 = require("sha1");
const CryptoJS = require("crypto-js");
const Communicator = require('./connect/Communicator.js')
const BusTopics = require('./utils/BusTopics');
const BusMsgPub = require("./msg/BusMsgPub");
const BusMsgSub = require("./msg/BusMsgSub");
const ChatManager = require("./utils/ChatManager");
const Version = require("./utils/version.js");
const superagent = require('superagent');
const {RoomAccess, RoomInfo, PeerCredentials, PeerInfo} = require('./protos/BusMessages.js');

/* time the housekeeping thread waits until it continues with the next step
 */
const houseKeepingTimeOut = 100;
const ROOM_ID_MIN = 11;
const ROOM_ID_MAX = 50;

class BusManager {
    rooms;

    constructor(_baseTopic) {
        this.translator = short(); // Defaults to flickrBase58
        this.protocolVersion = new Version().getProtocolVersion();
        this.communicator = new Communicator();
        this.busTopics = new BusTopics();
        this.rooms = {};
        this.peerHousekeep = {};
        this.roomHousekeep = {};
        this.houseKeepingInProgress = false;
        this.chatManagers = {};
        this.switchBoardURI = null;
    }

    /*********************************************************************
     **********************************************************************
     *
     *                     Switchboard CONNECTION
     *
     **********************************************************************
     **********************************************************************/

    /**
     * sets ths switchboard url to a individual url than the broker
     * @param _url switchboard url without the 'http://' prefix
     * @param _port switchboard port
     */
    configureSwitchBoard = (_url, _port) => {
        this.switchBoardURI = 'http://' + _url + ":" + _port + "/proxies/";
    }

    /*********************************************************************
     **********************************************************************
     *
     *                     BROKER CONNECTION
     *
     **********************************************************************
     **********************************************************************/

    /**
     * configure the mqtt broker connection.
     * It also sets the switchboard to the same url and port 3591 as default.
     * @param {*} _host url without the 'mqtt://' prefix
     * @param {*} _brokerPort mqtt broker port
     * @param {*} _switchboardPort switchboard port (0 = off)
     * @param {*} _username broker username
     * @param {*} _password broker password
     */
    configureServer = (_host, _brokerPort, _switchboardPort, _username, _password, _managerName) => {
        this.communicator.configure('mqtt://' + _host, _brokerPort, _username, _password, _managerName);
        if (this.switchBoardURI === null && _switchboardPort !== 0) {
            this.configureSwitchBoard(_host, _switchboardPort);
        }
    }

    /**
     * connect with mqtt broker
     */
    connectServer = async () => {
        console.log(`connecting to broker... `);
        await this.communicator.connect();
        // if connection was successfull, subscribe to all rooms
        await this.communicator.subscribe(new BusMsgSub(this.busTopics.baseRoomInfo('+').build(), this.onRooms, RoomInfo, 0));
        // and subscribe to creatRoom topic
        await this.communicator.subscribe(new BusMsgSub(this.busTopics.roomCreate().build(), this.onRoomAccess, PeerCredentials, 0));
        // subscribe to peer left messages
        await this.communicator.subscribe(new BusMsgSub(this.busTopics.peerLeaving().build(), this.onPeerLeaving, PeerCredentials, 0));


        console.log(`-> clean out the house ... `);
        // we wait a moment to start with houskeeping
        setTimeout(this.startHousekeeping, houseKeepingTimeOut);
    };

    /**
     * disconnect from mqtt broker
     */
    disconnectServer = async () => {
        await this.communicator.disconnect();
        this.communicator.clearSubscriptions();
    };


    /**********************************************************************
     **********************************************************************
     *
     *                              HOUSKEEPING
     *
     **********************************************************************
     **********************************************************************/

    /**
     * start the housekeeping
     */
    startHousekeeping = async () => {
        // we dont want to start another housekeeping process until the previous one has finished
        if(!this.houseKeepingInProgress){
            console.log(`  -> starting housekeeping -> gather all peers ...`);
            this.peerHousekeep = {};
            this.roomHousekeep = Object.assign({}, this.rooms); // clone the current room list

            // we start by subscribing to all peer info messages inside all rooms
            await this.communicator.subscribe(new BusMsgSub(this.busTopics.roomPeerJoin('+', '+').build(), this.onAllPeers, PeerInfo, 0));

            // now we have to wait a moment
            setTimeout(this.pingAllPeersAlive, houseKeepingTimeOut);
            this.houseKeepingInProgress = true;
        }
    }

    /**
     * method called by the retained joined messages from all the peers and all the rooms
     */
    onAllPeers = async (_topic, _message, _packet) => {
        console.log(`    -> peer '${_message.peerName}' found in room '${_message.roomName}'`);
        // we simple store them for the next step
        this.peerHousekeep[_message.peerId] = {
            peerId: _message.peerId,
            peerName: _message.peerName,
            roomName: _message.roomName,
        }
    };

    /**
     * ping all peers that are subscribed to each individual rooms
     */
    pingAllPeersAlive = async () => {
        if(this.houseKeepingInProgress) {
            console.log(`      -> housekeeping -> pinging all rooms ...`);
            const keys = Object.keys(this.rooms);

            // subscribe to all room ping alive topic
            await this.communicator.subscribe(new BusMsgSub(this.busTopics.baseRoomAlivePing("+").build(), this.onRoomAlive, PeerCredentials, 0));

            for (const key of keys) {
                // send ping message
                console.log(`        -> room '${key}' with id '${this.rooms[key].roomId}'...`);
                await this.communicator.publish(new BusMsgPub(this.busTopics.baseRoomAlive(key).build(), RoomInfo, 1, false).encode(
                    {
                        "timestamp": Math.round(new Date().getTime() / 1000),
                        "roomId": this.rooms[key].roomId,
                        "roomName": key,
                    }
                ));
            }
            // now we have to wait a moment
            setTimeout(this.cleanOut, houseKeepingTimeOut);
        }
    }

    /**
     * return messages from peers on room ping requests
     */
    onRoomAlive = async (_topic, _message, _packet) => {
        console.log(`        -> room '${_message.roomName}' alive with peer '${_message.peerName}'`);
        // if we receive this message, it means this peer is alive and we can remove it
        // from our housekeeping lists
        if (this.peerHousekeep[_message.peerId] !== null) {
            // before we send back a room access message, we have to make sure the room alive ping
            // came from a validly logged in peer:

            // we expect the password sent by the peer to be hashed, but the stored password to be
            // double hashed, so we double hash the peers password here
            let shaPassword = sha1(_message.roomPwd).substr(0, 10)
            if (this.rooms[_message.roomName].roomPwd === shaPassword) {
                // now we resend the access message
                // we need to do this in case the manager has crashed and restarted...
                // send access message
                await this.publishRoomAccess(
                    true,
                    _message.peerId,
                    _message.clientId,
                    _message.peerName,
                    _message.roomName,
                    this.rooms[_message.roomName].roomId,
                    this.rooms[_message.roomName].roomUUID,
                    _message.roomPwd,
                    "confirmation");
            }
            delete this.peerHousekeep[_message.peerId];
        }
        if (this.roomHousekeep[_message.roomName] !== null) {
            delete this.roomHousekeep[_message.roomName];
        }
    };

    /**
     * cleanout dead peers and rooms
     */
    cleanOut = async () => {
        if(this.houseKeepingInProgress) {
            console.log(`      -> housekeeping -> cleaning out ...`);
            // first we send clear retain messages to
            // all the peer joined addresses that have not replied:
            const clearRetain = async (currentPeer) => {
                console.log(`       <- remove peer '${currentPeer.peerName}' from room '${currentPeer.roomName}' `);
                await this.communicator.clearRetain(this.busTopics.roomPeerJoin(currentPeer.roomName, currentPeer.peerId).build());
                // send peer left to all remaining peers
                const infoPayload = {
                    timestamp: Math.round(new Date().getTime() / 1000),
                    peerId: currentPeer.peerId,
                    peerName: currentPeer.peerName,
                    roomName: currentPeer.roomName
                };

                await this.communicator.publish(
                    new BusMsgPub(
                        this.busTopics.roomPeerLeft(currentPeer.roomName, currentPeer.peerId).build(),
                        PeerInfo, 2, false).encode(infoPayload));
            }
            await Object.values(this.peerHousekeep).every(clearRetain);

            // and now we can delete the rooms
            const cleanupRooms = async (currentRoom) => await this.deleteRoom(currentRoom.roomName);
            await Object.values(this.roomHousekeep).every(cleanupRooms);

            // and we stop by unsubscribing to all peer info messages inside all rooms
            await this.communicator.unsubscribe(this.busTopics.roomPeerJoin('+', '+').build());
            // unsubscribing to all room ping alive topic
            await this.communicator.unsubscribe(this.busTopics.baseRoomAlivePing("+").build());
            // cleanup the communicator
            this.communicator.clearAutoGeneratedSubscriptions();
            console.log(`      -> housekeeping DONE`);
        } else {
            console.log(`      -> housekeeping was interrupted`);
        }
        this.houseKeepingInProgress = false;
    }

    /**
     * called when a peer leaves a room or disconnects in a unmanaged way.
     */
    onPeerLeaving = async (_topic, _message, _packet) => {
        console.log(`  <- peer '${_message.peerName}' leaving`);
        let shaPassword = sha1(_message.roomPwd).substr(0, 10)
        if (this.rooms.hasOwnProperty(_message.roomName)){
            if (this.rooms[_message.roomName].roomPwd === shaPassword){
                // cleanup retained peer join message
                await this.communicator.clearRetain(this.busTopics.roomPeerJoin(_message.roomName, _message.peerId).build());

                const infoPayload = {
                    timestamp: Math.round(new Date().getTime() / 1000),
                    peerId: _message.peerId,
                    peerName: _message.peerName,
                    roomName: _message.roomName
                };

                // send peer left to all remaining peers
                await this.communicator.publish(
                    new BusMsgPub(
                        this.busTopics.roomPeerLeft(_message.roomName, _message.peerId).build(),
                        PeerInfo, 2, false).encode(infoPayload));

                // we wait a moment to start with houskeeping
                setTimeout(this.startHousekeeping, houseKeepingTimeOut);
            } else {
                console.log(`!!! >BAD PLAYER<: somebody tried to remove peer without proper credentials!!!`);
            }
        }

    };

    /*********************************************************************
     **********************************************************************
     *
     *                        ACCESS MANAGEMENT
     *
     **********************************************************************
     **********************************************************************/

    /**
     * request from peer to access room
     *
     * >>> SECURITY consideration:
     *          In theory a bad actor could swamp this topic with new room creation
     *          requests. Very quickly all the room ids are taken.
     *          At the moment I have no idea how to avoid this.
     */
    onRoomAccess = async (_topic, _message, _packet) => {
        let accessGrant;
        let reason = "unknown";
        // check first the peer talks the same immersive Bus version as the manager.
        if(_message.protocolVersion === this.protocolVersion){
            // we expect the password sent by the peer to be hashed, but the stored password to be
            // double hashed, so we double hash the peers password here
            let clientId = _message.peerId;
            let shaPassword = sha1(_message.roomPwd).substr(0, 10)
            if (!this.rooms.hasOwnProperty(_message.roomName)){
                // room doesn't exist yet
                accessGrant = true;
                console.log(`  -> peer '${_message.peerName}' creating new room '${_message.roomName}' for app version: '${_message.appVersion}'`);
                reason = "no room of this name exists";
                await this.publishNewRoom(_message.roomName, shaPassword, _message.appVersion);
            } else {
                if (this.rooms[_message.roomName].roomPwd !== shaPassword) {
                    console.log(`  -> peer '${_message.peerName}' declined access to room: ${_message.roomName} | invalid password`);
                    accessGrant = false;
                    reason = "password invalid";
                } else if (this.rooms[_message.roomName].appVersion !== _message.appVersion) {
                    console.log(`  -> peer '${_message.peerName}' declined access to room: ${_message.roomName} | incompatible app version`);
                    accessGrant = false;
                    reason = `app version incompatible: required version is '${this.rooms[_message.roomName].appVersion}', yours is '${_message.appVersion}'`;
                } else {
                    //room exists: checked if the doubled hashed roomPwd is equal
                    accessGrant = true;
                    if(this.houseKeepingInProgress){
                        // if there is a housekeeping process in progress, we stop it right here.
                        this.houseKeepingInProgress = false;
                        // and we wait a moment to start with houskeeping again
                        setTimeout(this.startHousekeeping, houseKeepingTimeOut);
                    }
                    console.log(`  -> peer '${_message.peerName}' joining room '${_message.roomName}'`);
                }
            }
        } else {
            //console.log(`incompatible protocol version '${_message.protocolVersion}': room manager is running on tBus version '${this.protocolVersion}'`);
            accessGrant = false;
            reason = `incompatible protocol version '${_message.protocolVersion}': room manager is running on tBus version '${this.protocolVersion}'` ;
        }

        //console.log(`send access to address: ${this.busTopics.basePeerRoomAccess(_message.peerId).build()}.`);
        // send access message
        await this.publishRoomAccess(
            accessGrant,
            _message.peerId,
            _message.clientId,
            _message.peerName,
            _message.roomName,
            (accessGrant)?this.rooms[_message.roomName].roomId:0,
            (accessGrant)?this.rooms[_message.roomName].roomUUID:"0",
            _message.roomPwd,
            reason)

        if(accessGrant){
            //console.log(`publish info to address: ${this.busTopics.roomPeerJoin(_message.roomName, _message.peerId).build()}.`);
            // send peer joined message
            await this.communicator.publish(
                new BusMsgPub(
                    this.busTopics.roomPeerJoin(_message.roomName, _message.peerId).build(),
                    PeerInfo, 2, true).encode({
                        timestamp: Math.round(new Date().getTime() / 1000),
                        peerId: _message.peerId,
                        peerName: _message.peerName,
                        roomName: _message.roomName,
                        localIpV4: _message.localIpV4,
                        publicIpV4: _message.publicIpV4,
                    }));
        }
    };

    publishRoomAccess = async (_accessGranted, _peerId, _clientId, _peerName, _roomName, _roomId, _roomUuid, _roomPwd, _reason) => {
        await this.communicator.publish(
            new BusMsgPub(this.busTopics.basePeerRoomAccess(_clientId).build(),
                RoomAccess, 2, false).encode({
                    timestamp: Math.round(new Date().getTime() / 1000),
                    access: _accessGranted,
                    peerId: _peerId,
                    peerName: _peerName,
                    roomId: _roomId,
                    roomName: _roomName,
                    roomUuid: CryptoJS.AES.encrypt(_roomUuid, _roomPwd).toString(),
                    reason: _reason,
                }));
    }


    /*********************************************************************
     **********************************************************************
     *
     *                          ROOM MANAGEMENT
     *
     **********************************************************************
     **********************************************************************/
    /*   There are three ways a room can be created:
     *      - on connection of this script to the broker, this script gets retained messages:
     *         -> onRooms() -> createNewRoom()
     *      - on access request from a peer:
     *         -> onRoomAccess() -> publishNewRoom() -> createNewRoom()
     *      - for testing purposes
     *         max -> publishNewRoom() -> createNewRoom()
     */

    /**
     * publish a new room into the network
     * called when a peer request access to a non existing room.
     * @param {*} _roomName
     * @param {*} _roomPwd
     */
    publishNewRoom = async (_roomName, _roomPwd, _appVersion) => {
        // make sure the room really doesn't exists.
        if (!this.rooms.hasOwnProperty(_roomName)) {
            await this.createNewRoom(_roomName, _roomPwd, null, _appVersion);
            // send retained info message
            await this.communicator.publish(new BusMsgPub(this.busTopics.baseRoomInfo(_roomName).build(), RoomInfo, 2, true).encode(
                {
                    timestamp: Math.round(new Date().getTime() / 1000),
                    roomId: this.rooms[_roomName].roomId,
                    roomName: _roomName,
                    roomPwd: this.rooms[_roomName].roomPwd,
                    appVersion : _appVersion
                }
            ));
        }
    }

    /**
     * received when new room is created.
     * is called indirectly by publishNewRoom() or on startup by retained messages.
     */
    onRooms = async (_topic, _message, _packet) => {
        // since only the tBusManager creates new rooms, most likely the messages was received because
        // the tBusManager has restarted and gets now all the retained room infos.
        // this allows the tBusManager to get into the same state as before.
        if (!this.rooms.hasOwnProperty(_message.roomName)) {
            await this.createNewRoom(_message.roomName, _message.roomPwd, _message.roomId, _message.appVersion);
        }
    };

    /**
     * create a new room - either when a user tries to access a non existing room
     * or when a retained room message arrives on startup
     * @returns {Promise<void>}
     */
    createNewRoom = async (_roomName, _roomPwd, _roomId, _appVersion) => {
        let roomID = _roomId;
        // Generate short UUID as peerId
        let roomUUID = this.translator.new(); // mhvXdrZT4jP5T8vBxuvm75

        if(roomID === null)
            roomID = this.findUnusedRoomId();
        this.rooms[_roomName] = {
            roomName: _roomName,
            roomId: roomID,
            roomUUID: roomUUID,
            roomPwd: _roomPwd,
            appVersion: _appVersion
        }
        console.log(`-> generate room: '${_roomName}' with id '${roomID}' and uuid: '${roomID}'`);
        console.log(`     with uuid: '${roomUUID}'`);
        // create a chatmanager for this room
        this.chatManagers[_roomName] = new ChatManager(this.communicator, _roomName, _roomPwd);
        // and connect it
        await this.chatManagers[_roomName].connect();
        await this.startServerSidePortScripts(_roomName, roomID);
    }

    /**
     * find the lowest ID to use as roomId
     */
    findUnusedRoomId = () => {
        //console.log(`all id values :${JSON.stringify(Object.values(this.rooms))}`);
        for (let i = ROOM_ID_MIN; i < ROOM_ID_MAX; i++) {
            const isEqual = (currentValue) => currentValue.roomId !== i;
            if (Object.values(this.rooms).every(isEqual)) {
                //console.log(`foundUnusedRoomId :${i}`);
                return i;
            }
        }
    }

    /**
     * deletes room, called by the housekeeping routine
     * @param {*} _roomName
     */
    deleteRoom = async (_roomName) => {
        // make sure the room really exists.
        if (this.rooms.hasOwnProperty(_roomName)) {
            console.log(`       <- remove room '${_roomName}' with id '${this.rooms[_roomName].roomId}' `);

            // stop the ports
            await this.stopServerSidePortScripts(_roomName, this.rooms[_roomName].roomId);

            // stop the and cleanup the room chat
            if (this.chatManagers.hasOwnProperty(_roomName)) {
                // stop the chatManager and delete it for this rom
                await this.chatManagers[_roomName].disconnect();
                delete this.chatManagers[_roomName];
            }

            // then we subscribe to all retained messages of this room
            await this.communicator.subscribe(new BusMsgSub(this.busTopics.baseRoomSubTopics(_roomName).build(), this.onAllRoomTopics, null, 0));

            // send delete room message to all listening peers
            await this.communicator.publish(new BusMsgPub(this.busTopics.roomDelete(_roomName).build(), RoomInfo, 2, false).encode(
                {
                    timestamp: Math.round(new Date().getTime() / 1000),
                    roomId: this.rooms[_roomName].roomId,
                    roomName: _roomName
                }
            ));

            // clear retained info message
            await this.communicator.clearRetain(this.busTopics.baseRoomInfo(_roomName).build());

            // and by now all retained messages in this room have been cleaned up
            await this.communicator.unsubscribe(this.busTopics.baseRoomSubTopics(_roomName).build());

            delete this.rooms[_roomName];
        }
    }

    /**
     * received when room is deleted.
     * is called by subscriptionions created by deleteRoom() and has the purpose of cleaning up all retained messages inside this room
     */
    onAllRoomTopics = async (_topic, _message, _packet) => {
        // clear retained message
        await this.communicator.clearRetain(_topic);
        await this.communicator.unsubscribe(_topic);
        // console.log(`         <- removed retained topic '${_topic}' `);
    };

    /*********************************************************************
     **********************************************************************
     *
     *                     SERVER SIDE PORT SCRIPT
     *
     **********************************************************************
     **********************************************************************/

    /**
     * Start server side port scripts
     */
    startServerSidePortScripts = async (_roomName, _roomId) => {
        if(this.switchBoardURI !== null){
            console.log(`        -> starting ports for room '${_roomName}' on range '${_roomId}000 - ${_roomId}999`);
            try{
                for (let i = 0; i < 10; i++) {
                    await this.addSwitchBoardProxy(_roomName,_roomId * 1000 + i, 'many2manyBi', "UDP proxy, channel:" + i);
                    await this.addSwitchBoardProxy(_roomName, _roomId * 1000 + 100 + i * 10, 'one2manyMo', "Ultragrid proxy, channel:" + i);
                    await this.addSwitchBoardProxy(_roomName, _roomId * 1000 + 200 + i * 10, 'one2manyBi', "MoCap proxy, channel:" + i);
                }
            } catch(err){
                console.error(`      ...: ${err}. Interrupting process of starting up server side scripts.`);
            }
            console.log(`        <- started all ports for room ${_roomName}`);
        } else {
            console.log(`        ...started no ports for room ${_roomName}: no switchboard url/port defined`);
        }
    }

    /**
     * Stop server side port scripts
     */
    stopServerSidePortScripts = async (_roomName, _roomId) => {
        if(this.switchBoardURI !== null) {
            console.log(`        -> stopping ports for room '${_roomName}' on range '${_roomId}000 - ${_roomId}999`);
            try {
                for (let i = 0; i < 10; i++) {
                    await this.deleteSwitchBoardProxy(_roomId * 1000 + i);
                    await this.deleteSwitchBoardProxy(_roomId * 1000 + 100 + i * 10);
                    await this.deleteSwitchBoardProxy(_roomId * 1000 + 200 + i * 10);
                }
            } catch (err) {
                console.error(`      ...: ${err}. Interrupting process of stopping server side scripts.`);
            }
            console.log(`        <- stopped all ports for room ${_roomName}`);
        }else {
            console.log(`        ...stopped no ports for room ${_roomName}: no switchboard url/port defined`);
        }
    }

    /**
     * start individual server side port proxy
     */
    addSwitchBoardProxy = async (_room, _port, _type, _description) => {
        try {
            let payload = { room: _room, port: _port, type: _type, description: _description };
            await superagent.post(this.switchBoardURI).send(payload).then(res => {

            });
            //let reply = JSON.parse(res["text"]);
        } catch (err) {
            //console.error(err);
            let reply = JSON.parse(err.response["text"]);
            throw new Error(reply["msg"]);
        }
    }

    /**
     * stop individual server side port proxy
     */
    deleteSwitchBoardProxy = async (_port) => {
        try {
            const res = await superagent.delete(this.switchBoardURI + _port).then(res => {
            });
            //let reply = JSON.parse(res["text"]);
        } catch (err) {
            let reply = JSON.parse(err.response["text"]);
            throw new Error(reply["msg"]);
        }
    }

}

module.exports = BusManager;
