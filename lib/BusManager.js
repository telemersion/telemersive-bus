const sha1 = require("sha1");
const Communicator = require('./connect/Communicator.js')
const BusTopics = require('./utils/BusTopics');
const BusMsgPub = require("./msg/BusMsgPub");
const BusMsgSub = require("./msg/BusMsgSub");
const ChatManager = require("./utils/ChatManager");
const Version = require("./utils/version.js");
const {RoomAccess, RoomInfo, PeerCredentials, PeerInfo} = require('./protos/BusMessages.js');

/* time the housekeeping thread waits until it continues with the next step
 */
const houseKeepingTimeOut = 100;
const ROOM_ID_MIN = 11;
const ROOM_ID_MAX = 50;

class BusManager {
    rooms;

    constructor(_baseTopic) {
        this.protocolVersion = new Version().getProtocolVersion();
        this.communicator = new Communicator(this.peerId);
        this.busTopics = new BusTopics();
        this.rooms = {};
        this.peerHousekeep = {};
        this.roomHousekeep = {};
        this.houseKeepingInProgress = false;
        this.chatManagers = {};
    }

    /*********************************************************************
     **********************************************************************
     *
     *                     BROKER CONNECTION
     *
     **********************************************************************
     **********************************************************************/

    /**
     * configure the mqtt broker connection
     * @param {*} _host
     * @param {*} _port
     * @param {*} _username
     * @param {*} _password
     */
    configureServer = (_host, _port, _username, _password, _managerName) => {
        this.communicator.configure(_host, _port, _username, _password, _managerName);
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
     * methd called by the retained joined messages from all the peers and all the rooms
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
            await this.communicator.subscribe(new BusMsgSub(this.busTopics.baseRoomAlivePing("+").build(), this.onRoomAlive, PeerInfo, 0));

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
            console.log(`    -> housekeeping -> cleaning out ...`);
            // first we send clear retain messages to
            // all the peer joined addresses that have not replied:
            const clearRetain = async (currentPeer) => {
                console.log(`      <- remove peer '${currentPeer.peerName}' from room '${currentPeer.roomName}' `);
                await this.communicator.clearRetain(this.busTopics.roomPeerJoin(currentPeer.roomName, currentPeer.peerId).build());
            }
            await Object.values(this.peerHousekeep).every(clearRetain);

            // and now we can delete the rooms
            const cleanoutRooms = async (currentRoom) => await this.deleteRoom(currentRoom.roomName);
            await Object.values(this.roomHousekeep).every(cleanoutRooms);

            // and we stop by unsubscribing to all peer info messages inside all rooms
            await this.communicator.unsubscribe(this.busTopics.roomPeerJoin('+', '+').build());
            // unsubscribing to all room ping alive topic
            await this.communicator.unsubscribe(this.busTopics.baseRoomAlivePing("+").build());
            // cleanup the communicator
            this.communicator.clearAutoGeneratedSubscriptions();
            console.log(`  -> housekeeping DONE`);
        } else {
            console.log(`  -> housekeeping was interrupted`);
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
            let shaPassword = sha1(_message.roomPwd).substr(0, 10)
            if (!this.rooms.hasOwnProperty(_message.roomName)){
                // room doesn't exist yet
                accessGrant = true;
                console.log(`  -> peer '${_message.peerName}' creating new room '${_message.roomName}'`);
                reason = "no room of this name exists";
                await this.publishNewRoom(_message.roomName, shaPassword);
            } else if (this.rooms[_message.roomName].roomPwd === shaPassword) {
                //room exists: checked if the doubled hashed roomPwd is equal
                accessGrant = true;
                if(this.houseKeepingInProgress){
                    // if there is a housekeeping process in progress, we stop it right here.
                    this.houseKeepingInProgress = false;
                    // and we wait a moment to start with houskeeping again
                    setTimeout(this.startHousekeeping, houseKeepingTimeOut);
                }
                console.log(`  -> peer '${_message.peerName}' joining room '${_message.roomName}'`);
            } else {
                console.log(`  -> peer '${_message.peerName}' declined access to room: ${_message.roomName}`);
                accessGrant = false;
                reason = "password invalid";
            }
        } else {
            //console.log(`incompatible protocol version '${_message.protocolVersion}': room manager is running on iBus version '${this.iBusVersion}'`);
            accessGrant = false;
            reason = `incompatible protocol version '${_message.protocolVersion}': room manager is running on iBus version '${this.protocolVersion}'` ;
        }

        //console.log(`send access to address: ${this.busTopics.basePeerRoomAccess(_message.peerId).build()}.`);
        // send access message
        await this.communicator.publish(
            new BusMsgPub(
                this.busTopics.basePeerRoomAccess(_message.peerId).build(),
                RoomAccess, 2, false).encode({
                    timestamp: Math.round(new Date().getTime() / 1000),
                    access: accessGrant,
                    peerId: _message.peerId,
                    peerName: _message.peerName,
                    roomId: (accessGrant)?this.rooms[_message.roomName].roomId:0,
                    roomName: _message.roomName,
                    reason: reason,
                }));

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
    publishNewRoom = async (_roomName, _roomPwd) => {
        // make sure the room really doesn't exists.
        if (!this.rooms.hasOwnProperty(_roomName)) {
            await this.createNewRoom(_roomName, _roomPwd, null);
            // send retained info message
            await this.communicator.publish(new BusMsgPub(this.busTopics.baseRoomInfo(_roomName).build(), RoomInfo, 2, true).encode(
                {
                    timestamp: Math.round(new Date().getTime() / 1000),
                    roomId: this.rooms[_roomName].roomId,
                    roomName: _roomName,
                    roomPwd: this.rooms[_roomName].roomPwd
                }
            ));
        }
    }

    /**
     * received when new room is created.
     * is called indirectly by publishNewRoom() or on startup by retained messages.
     */
    onRooms = async (_topic, _message, _packet) => {
        // since only the IBusManager creates new rooms, most likely the messages was received because
        // the IBusManager has restarted and gets now all the retained room infos.
        // this allows the IBusManager to get into the same state as before.
        if (!this.rooms.hasOwnProperty(_message.roomName)) {
            await this.createNewRoom(_message.roomName, _message.roomPwd, _message.roomId);
        }
    };

    /**
     * create a new room - either when a user tries to access a non existing room
     * or when a retained room message arrives on startup
     * @returns {Promise<void>}
     */
    createNewRoom = async (_roomName, _roomPwd, _roomId) => {
        let roomID = _roomId;
        if(roomID === null)
            roomID = this.findUnusedRoomId();
        this.rooms[_roomName] = {
            roomName: _roomName,
            roomId: roomID,
            roomPwd: _roomPwd
        }
        console.log(`-> generate room: '${_roomName}' with id '${roomID}'`);
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
        // make sure the room realy extist.
        if (this.rooms.hasOwnProperty(_roomName)) {
            console.log(`      <- remove room '${_roomName}' with id '${this.rooms[_roomName].roomId}' `);

            if (this.chatManagers.hasOwnProperty(_roomName)) {
                // stop the chatManager and delete it for this rom
                await this.chatManagers[_roomName].disconnect();
                delete this.chatManagers[_roomName];
            }

            this.stopServerSidePortScripts(_roomName, this.rooms[_roomName].roomId);

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

            delete this.rooms[_roomName];
        }
    }

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
    startServerSidePortScripts = (_roomName, _roomId) => {
        console.log(`-> starting ports for room '${_roomName}' on range '${_roomId}00 - ${_roomId}99`);
        console.log(`   ...started room ${_roomName}`);
    }

    /**
     * Stop server side port scripts
     */
    stopServerSidePortScripts = (_roomName, _roomId) => {
        console.log(`      <- stopping ports for room '${_roomName}' on range '${_roomId}00 - ${_roomId}99`);
        console.log(`         ...stopped room ${_roomName}`);
    }

}

module.exports = BusManager;
