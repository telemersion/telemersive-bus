const publicIp = require('public-ip');
const internalIp = require('internal-ip');
const sha1 = require("sha1");
const CryptoJS = require("crypto-js");

const BusMsgPub = require("../msg/BusMsgPub");
const BusMsgSub = require("../msg/BusMsgSub");
const BusTopics = require('./BusTopics');
const { PeerInfo, RoomInfo, RoomAccess } = require('../protos/BusMessages.js');

const ChatClient = require("./ChatClient");
const MQTTClient = require("./MQTTClient");
const OSCClient = require("./OSCClient");
const SpeedClient = require("./SpeedClient");

const Version = require("./version.js");

class Peer {
    mqttClient;
    oscClient;
    speedClient;
    roomName;

    constructor(_communicator, _peerId)
    {
        this.protocolVersion = new Version().getProtocolVersion();

        this.communicator = _communicator;
        this.busTopics = new BusTopics();
        this.chatClient = new ChatClient(_communicator, _peerId);
        this.mqttClient = new MQTTClient(_communicator, _peerId);
        this.oscClient = new OSCClient(_communicator, _peerId);
        this.speedClient = new SpeedClient(_communicator, _peerId);
        this.peers = {};
        this.peerId = _peerId;
        this.peerName = null;
        this.roomName = null;
        this.roomPwd = null;
        this.roomId = 0;
        this.joined = false;
        this.BusCredentials = null;
        this.BusInfo = null;
        this.publicIPv4 = null;
        this.localIPv4 = null;
    }

    gatherIPs = async () => {
        this.publicIPv4 = await publicIp.v4();
        this.localIPv4 = await internalIp.v4();
 //       this.publicIPv6 = await publicIp.v6(); // seems to be a problem on windows
 //       this.localIPv6 = await internalIp.v6(); // seems to be a problem on windows
    };

    /**
     * encrypt string with room password
     * @param _message
     * @returns {string}
     */
    encrypt = (_message) => {
        // Encrypt
        return CryptoJS.AES.encrypt(_message, this.roomPwd).toString();
    }

    /**
     * decrypt string with room password
     * @param _message
     * @returns {string}
     */
    decrypt = (_message) => {
        // Decrypt
        const bytes  = CryptoJS.AES.decrypt(_message, this.roomPwd);
        return bytes.toString(CryptoJS.enc.Utf8);
    }

    /**
     * initialize peer on new join message
     * create credentials
     * @param _peerName
     * @param _roomName
     * @param _roomPwd
     */
    init = (_peerName, _roomName, _roomPwd) => {
        this.peerName = _peerName;
        this.roomName = _roomName;
        this.roomPwdHashed = sha1(_roomPwd).substr(0, 10);
        this.roomPwd = _roomPwd;
        this.joined = false;

        const localIpV4 = this.encrypt(this.localIPv4);
        const publicIpV4 = this.encrypt(this.publicIPv4);

        this.BusCredentials = {
            protocolVersion: this.protocolVersion,
            peerId: this.peerId,
            peerName: this.peerName,
            roomName: this.roomName,
            roomPwd: this.roomPwdHashed,
            localIpV4: localIpV4,
            publicIpV4: publicIpV4,
        };

        this.BusInfo = {
            peerId: this.peerId,
            peerName: this.peerName,
            roomName: this.roomName,
            localIpV4: localIpV4,
            publicIpV4: publicIpV4,
        };

        this.chatClient.init(this.peerName, this.roomName, this.roomPwdHashed);
        this.mqttClient.init(this.peerName, this.roomName, this.roomPwdHashed);
        this.oscClient.init(this.peerName, this.roomName, this.roomPwdHashed);
        this.speedClient.init(this.peerName, this.roomName, this.roomPwdHashed);
    };

    /**
     * Set the call back function to return messages to max
     */
    setCallBackFunction(_callBackFunc){
        this.bubbleUpCallback = _callBackFunc;
        this.chatClient.setCallBackFunction(_callBackFunc);
        this.mqttClient.setCallBackFunction(_callBackFunc);
        this.oscClient.setCallBackFunction(_callBackFunc);
        this.speedClient.setCallBackFunction(_callBackFunc);
    }

    getCredentials = () => {
        this.BusCredentials.timestamp = Math.round(new Date().getTime() / 1000);
        return this.BusCredentials;
    };

    getBusInfo = () => {
        this.BusInfo.timestamp = Math.round(new Date().getTime() / 1000);
        return this.BusInfo;
    };

    isJoined = () => {
        return this.joined;
    };

    /**
     * joins the approved peer to the room
     */
    join = async (_roomId) => {
        if(!this.joined){
            console.log("peer joining...");
            this.roomId = _roomId;

            // let the chat client join
            await this.chatClient.join(_roomId);
            await this.mqttClient.join(_roomId);
            await this.oscClient.join(_roomId);
            await this.speedClient.join(_roomId);

            this.joined = true;

            this.updateCallback();

            // it is important to start the subscription after a successfull joining.
            // subscribe to all peer joined messages
            await this.communicator.subscribe(new BusMsgSub(this.busTopics.roomPeerJoin(this.roomName, '+').build(), this.onPeerJoined, PeerInfo, 0));

            // subscribe to peer left messages
            await this.communicator.subscribe(new BusMsgSub(this.busTopics.roomPeerLeft(this.roomName, '+').build(), this.onPeerLeft, PeerInfo, 0));

            // subscribe to my room ping messages
            await this.communicator.subscribe(new BusMsgSub(this.busTopics.baseRoomAlive(this.roomName).build(), this.onRoomPing, RoomInfo, 0));
        }
        return true;
    }

    /**
     * send a message to the chat
     * @param _message string
     */
    chat = async (_message) =>{
        if(this.joined)
            await this.chatClient.chat(_message);
    }

    /**
     * leaves to peer from the joined room
     */
    leave = async () => {
        await this.chatClient.leave();
        await this.mqttClient.leave();
        await this.oscClient.leave();
        await this.speedClient.leave();

        // unsubscribe to peer left messages
        await this.communicator.unsubscribe(this.busTopics.roomPeerLeft(this.roomName, '+').build());

        // unsubscribe to all peer joined messages
        await this.communicator.unsubscribe(this.busTopics.roomPeerJoin(this.roomName, '+').build());
        
        // unsubscribe to my room ping messages
        await this.communicator.unsubscribe(this.busTopics.baseRoomAlive(this.roomName).build());

        this.communicator.clearAutoGeneratedSubscriptions();

        this.peers = {};
        this.joined = false;

        this.updateCallback();
        this.updatePeerListMessage();
    }

    /**
     * called by the manager when a new peer joins the room
     */
    onPeerJoined = async (_topic, _message, _packet) => {
        if (_message.peerId === this.peerId){
            //console.log("onPeerJoined: its our own message, discard.");
            return;
        }
        // if the peer joined the same room and has not yet been registered
        if(_message.roomName === this.roomName && this.peers[_message.peerId] == null){
            console.log(`    -> peer '${_message.peerName}' joined my room`);
            this.peers[_message.peerId] = {
                peerName: _message.peerName,
                peerId: _message.peerId,
                localIpV4: this.decrypt(_message.localIpV4),
                publicIpV4: this.decrypt(_message.publicIpV4),
            }
            // check if peer has identical name to this
            if(this.peerName === _message.peerName){
                this.bubbleUpCallback('bus', [ 'warning', 'peer', `another peer is using the same name: '${this.peerName}'`]);
            }
            this.updatePeerListMessage();
        }
    };

    /**
     * called by the manager when a peer leaves the room
     */
    onPeerLeft = async (_topic, _message, _packet) => {
        if (_message.peerId === this.peerId){
            //console.log("!!BAD ACTOR: onPeerLeft: its our own message, discard.");
            return;
        }

        if(this.peers[_message.peerId] != null){
            console.log(`    <- peer '${_message.peerName}' left my room`);
            delete this.peers[_message.peerId];
            this.updatePeerListMessage();
        } else {
            //console.log(`peer '${_message.peerName}' left from room '${_message.roomName}'`);
        }
    };

    /**
     * updates the app with the current list of joined peers
     */
    updatePeerListMessage = () => {
        this.bubbleUpCallback('bus', [ 'peers', 'menu', 'clear']);
        const sendPeers = (currentPeer) => this.bubbleUpCallback('bus', [ 'peers', 'menu', 'append', currentPeer.peerName, currentPeer.peerId, currentPeer.localIpV4, currentPeer.publicIpV4]);
        Object.values(this.peers).every(sendPeers); 
        this.bubbleUpCallback('bus', [ 'peers', 'done']);
    }

    /**
     * updates the application about the current status via bubbleUpCallbacks
     */
    updateCallback = () => {
        this.bubbleUpCallback('bus', [ 'peer', 'name', this.peerName]);
        this.bubbleUpCallback('bus', [ 'peer', 'id', this.peerId]);
        this.bubbleUpCallback('bus', [ 'peer', 'localIP', this.localIPv4]);
        this.bubbleUpCallback('bus', [ 'peer', 'publicIP', this.publicIPv4]);
        this.bubbleUpCallback('bus', [ 'peer', 'room', 'name', (this.isJoined())?this.roomName:'>not joined<']);
        this.bubbleUpCallback('bus', [ 'peer', 'room', 'id', (this.isJoined())?this.roomId:0]);
        // it is important to send the joined message at the end...
        this.bubbleUpCallback('bus', [ 'peer', 'joined', (this.isJoined())?1:0]);
    }

    /**
     * called by the manager to see if the peer is still joined. it returns a ping answer
     */
    onRoomPing = async (_topic, _message, _packet) => {
        //console.log(`${this.peerName}] onRoomPing: room: ${_message.roomName} | ${_message.roomId}`);
        //console.log(`${this.peerName}] onRoomPing: peer: ${this.peerId} | ${this.peerName}`);
        //console.log(`Payload: ${JSON.stringify(payload)}`);

        // send my room alive message
        await this.communicator.publish(
            new BusMsgPub(this.busTopics.baseRoomAlivePing(_message.roomName).build(),
                PeerInfo, 1, false).encode(this.getBusInfo()));
    }
}

module.exports = Peer;