class BusMsg
{
    topic;
    class;
    type = 0;

    /**
     * DO NOT USE THIS CLASS DIRECTLY
     * @param {*} _topic 
     * @param {*} _class
     */
    constructor(_topic, _class){
        this.topic = _topic;
        this.class = _class;
        if(typeof this.class.verify === "function"){
            this.type = 0;
        } else if (typeof this.class.constructor.name == "object"){
            this.type = 1;
        } else if (typeof(this.class) == "string"){
            this.type = 2;
        }
    }
}

module.exports = BusMsg;
