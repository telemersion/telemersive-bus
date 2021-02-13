const short = require('short-uuid');
const Communicator = require('./connect/Communicator.js')
const Peer = require('./utils/Peer.js');
const BusMsgPub = require("./msg/BusMsgPub");
const BusMsgSub = require("./msg/BusMsgSub");
const { RoomAccess, PeerCredentials, RoomInfo } = require('./protos/BusMessages.js');
const BusTopics = require('./utils/BusTopics');

class BusClient {
    peer;

    constructor()
    {
        const translator = short(); // Defaults to flickrBase58
        // Generate short UUID as peerId
        this.peerId = translator.new(); // mhvXdrZT4jP5T8vBxuvm75

        this.communicator = new Communicator(this.peerId);
        this.peer = new Peer(this.communicator, this.peerId);
        this.busTopics = new BusTopics();
        this.rooms = [];
        this.bubbleUpCallback = null; // bubbleUpFuncion to call parent class
        this.joinTimeout = null;
        this.connectTimeout = null;
    }

    init = async () => {
        console.log("init: gathering IP information... ");
        await this.peer.gatherIPs();
        console.log("   ...gathering done.");
    }

    /**
     * Set the call back function to return messages to max
     */
    setCallback = (_func) => {
        this.bubbleUpCallback = _func;
        this.peer.setCallBackFunction(_func);
    }

    /**
     * configure the mqtt broker connection
     * @param {*} _host
     * @param {*} _port
     * @param {*} _username
     * @param {*} _password
     * @param _peerName
     */
    configureServer = (_host, _port, _username, _password, _peerName) => {
        this.communicator.configure(_host, _port, _username, _password, _peerName);
    }

    /**
     * connect with mqtt broker
     */
    connectServer = async () => {
        console.log("connect: attempting to connect to broker...")
        try{
            this.connectTimeout = setTimeout(this.connectionTimeout,1000);
            await this.communicator.connect();
            // if connection was successful, subscribe to room info topic
            await this.communicator.subscribe(new BusMsgSub(this.busTopics.baseRoomInfo('+').build(), this.onRooms, RoomInfo, 0));
            // if connection was successful, subscribe to room delete topic
            await this.communicator.subscribe(new BusMsgSub(this.busTopics.roomDelete().build(), this.onRoomDelete, RoomInfo, 0));
            // if connection was successful, subscribe to roomAccess topic
            await this.communicator.subscribe(new BusMsgSub(this.busTopics.basePeerRoomAccess(this.peerId).build(), this.onRoomJoined, RoomAccess, 0));
            //console.log(`...subscribe to. ${this.busTopics.basePeerRoomAccess(this.peerId).build()}`);
            this.bubbleUpCallback('bus', [ 'broker', 'connected', 1]);
            console.log("...successfully connected.");
        } catch (e) {
            console.log("...unsuccessful connection attempt.");
            if(typeof(e) === 'object'){
                if(e.code === 5){
                    this.bubbleUpCallback('bus', [ 'error', 'broker', "username / password invalid. connection refused"]);
                } else if (e.code === "ECONNREFUSED"){
                    this.bubbleUpCallback('bus', [ 'error', 'broker', "invalid configuration. connection refused"]);
                } else if (e.code === "ERR_INVALID_URL"){
                    this.bubbleUpCallback('bus', [ 'error', 'broker', `invalid url: '${e.input}'. connection refused`]);
                } else {
                    this.bubbleUpCallback('bus', [ 'error', 'broker', JSON.stringify(e)]);
                }
            }
            else {
                this.bubbleUpCallback('bus', [ 'error', 'broker', e]);
            }
            this.bubbleUpCallback('bus', [ 'broker', 'connected', 0]);
        }
        if(this.connectTimeout !== null){
            // we stop the timeout thread
            console.log("...stopping timout thread.");
            clearTimeout(this.connectTimeout);
        }
    }

    /**
     * disconnect from mqtt broker
     */
    disconnectServer = async () => {
        console.log("disconnecting...");
        // first we leave the room
        await this.leave();
        // then we clean up all subscriptions
        await this.communicator.unsubscribeAll();
        // and properly disconnect
        await this.communicator.disconnect();
        // and send a feedback
        this.bubbleUpCallback('bus', [ 'broker', 'connected', 0]);
        // clean all stored infos about rooms
        this.rooms = [];
        console.log("...successfully disconnected.");
    }

    /**
     * attempting to join the peer under this name and room
     * @param {*} _peerName 
     * @param {*} _roomName 
     * @param {*} _roomPwd 
     */
    join = async (_peerName, _roomName, _roomPwd) => {
        console.log(`attempting to join room ${_roomName}...`);
        if(!this.peer.isJoined()){
            if(this.communicator.isConnected()){

                // initialize peer
                await this.peer.init( _peerName, _roomName, _roomPwd);

                // send room create message
                await this.communicator.publish(
                    new BusMsgPub(
                        this.busTopics.roomCreate().build(),
                        PeerCredentials, 1, false).encode(this.peer.getCredentials()));

                this.joinTimeout = setTimeout(this.joinedTimeout,5000);
            } else {
                this.bubbleUpCallback('bus', [ 'error', 'peer', 'cannot join unless connected']);
            }
        } else {
            this.bubbleUpCallback('bus', [ 'error', 'peer', 'already joined']);
        }
    }

    connectionTimeout = () => {
        console.log("-> connection timeout");
        this.bubbleUpCallback('bus', [ 'broker', 'connected', 0]);
        this.bubbleUpCallback('bus', [ 'error', 'broker', 'timeout: broker is not answering. check configure.']);
    }

    joinedTimeout = () => {
        console.log("-> room join timeout");
        this.bubbleUpCallback('bus', [ 'peer', 'joined', 0]);
        this.bubbleUpCallback('bus', [ 'error', 'peer', 'timeout: manager is not answering']);
    }

    /**
     * answer from room manager on request to create / join room
     */
    onRoomJoined = async (_topic, _message, _packet) => {
        if(this.joinTimeout !== null){
            // we stop the timeout thread
            clearTimeout(this.joinTimeout);
        }
        if (_message.access === false){
            console.log(`ERROR: room ${_message.roomName} access declined - ${_message.reason}.`);
            this.bubbleUpCallback('bus', [ 'error', 'peer', `join access declined - ${_message.reason}`]);
            this.bubbleUpCallback('bus', [ 'peer', 'joined', 0]);
            return;
        }

        if(!this.peer.isJoined()){
            console.log(`... access to room ${_message.roomName} accepted.`);

            // now we can join the peer and give it its room id
            await this.peer.join(_message.roomId);

            // only now we reconnect to broker and set the correct last will message
            // with the room info and password
            await this.communicator.reconnect(
                new BusMsgPub(
                    this.busTopics.peerLeaving().build(),
                    PeerCredentials, 2, false).encode(this.peer.getCredentials()));
        }
    };

    /**
     * command to let the peer leave to room
     * @returns {Promise<void>}
     */
    leave = async () => {
        //console.log("...leaving my room");
        if(this.peer.isJoined()){
            // send peer leaving message
            await this.communicator.publish(
                new BusMsgPub(
                    this.busTopics.peerLeaving().build(),
                    PeerCredentials, 2, false).encode(this.peer.getCredentials()));

            //console.log("...was connected....");
            await this.peer.leave();
            console.log("<- peer left the room");
        }
    }

    /**
     * message from manager if a room has been removed
     */
    onRoomDelete = async (_topic, _message, _packet) => {
        // remove room from list
        if(this.rooms.includes(_message.roomName)) {
            console.log(`  <- room '${_message.roomName}' removed by manager`);
            this.rooms.splice(this.rooms.indexOf(_message.roomName), 1);
            // update app
            this.updateRoomListMessage()
            // unlikely event:
            if (this.peer.isJoined() && this.peer.roomName === _message.roomName) {
                console.log(`... this room is this peers room!!`);
            }
        }
    };

    /**
     * retained messages about existing rooms
     */
    onRooms = async (_topic, _message, _packet) => {
        if(!this.rooms.includes(_message.roomName)){
            console.log(`  -> room '${_message.roomName}' registered`);
            this.rooms.push(_message.roomName);
            this.updateRoomListMessage()
        } else {
            //console.log(`... room info duplicate: ignoring`);
        }
    };

    /**
     * helper function to return current room list back to max
     */
    updateRoomListMessage = () => {
        this.bubbleUpCallback('bus', [ 'rooms', 'menu', 'clear']);
        const sendRooms = (currentRoom) => this.bubbleUpCallback('bus', [ 'rooms', 'menu', 'append', currentRoom]);
        this.rooms.forEach(sendRooms);
        if(this.peer.roomName === true){
            this.bubbleUpCallback('bus', [ 'rooms', 'menu', 'set', this.peer.roomName]);
        }
        this.bubbleUpCallback('bus', [ 'rooms', 'listing', ...this.rooms]);
        this.bubbleUpCallback('bus', [ 'rooms', 'done']);
    }

}

module.exports = BusClient;
