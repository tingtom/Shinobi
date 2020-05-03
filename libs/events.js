var moment = require('moment');
var execSync = require('child_process').execSync;
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var request = require('request');
module.exports = function(s,config,lang){
    var addEventDetailsToString = function(eventData,string,addOps){
        //d = event data
        if(!addOps)addOps = {}
        var newString = string + ''
        var d = Object.assign(eventData,addOps)
        var detailString = s.stringJSON(d.details)
        newString = newString
            .replace(/{{TIME}}/g,d.currentTimestamp)
            .replace(/{{REGION_NAME}}/g,d.details.name)
            .replace(/{{SNAP_PATH}}/g,s.dir.streams+'/'+d.ke+'/'+d.id+'/s.jpg')
            .replace(/{{MONITOR_ID}}/g,d.id)
            .replace(/{{GROUP_KEY}}/g,d.ke)
            .replace(/{{DETAILS}}/g,detailString)
        if(d.details.confidence){
            newString = newString
            .replace(/{{CONFIDENCE}}/g,d.details.confidence)
        }
        return newString
    }
    s.filterEvents = function(x,d){
        switch(x){
            case'archive':
                d.videos.forEach(function(v,n){
                    s.video('archive',v)
                })
            break;
            case'delete':
                s.deleteListOfVideos(d.videos)
            break;
            case'execute':
                exec(d.execute,{detached: true})
            break;
        }
        s.onEventTriggerBeforeFilterExtensions.forEach(function(extender){
            extender(x,d)
        })
    }
    s.triggerEvent = function(d,forceSave){
        var filter = {
            halt : false,
            addToMotionCounter : true,
            useLock : true,
            save : true,
            webhook : true,
            command : true,
            record : true,
            indifference : false
        }
        s.onEventTriggerBeforeFilterExtensions.forEach(function(extender){
            extender(d,filter)
        })
        var detailString = JSON.stringify(d.details);
        if(!s.group[d.ke]||!s.group[d.ke].activeMonitors[d.id]){
            return s.systemLog(lang['No Monitor Found, Ignoring Request'])
        }
        d.mon=s.group[d.ke].rawMonitorConfigurations[d.id];
        var currentConfig = s.group[d.ke].activeMonitors[d.id].details
        var hasMatrices = (d.details.matrices && d.details.matrices.length > 0)
        //read filters
        if(
            currentConfig.use_detector_filters === '1' &&
            ((currentConfig.use_detector_filters_object === '1' && d.details.matrices) ||
            currentConfig.use_detector_filters_object !== '1')
        ){
            var parseValue = function(key,val){
                var newVal
                switch(val){
                    case'':
                        newVal = filter[key]
                    break;
                    case'0':
                        newVal = false
                    break;
                    case'1':
                        newVal = true
                    break;
                    default:
                        newVal = val
                    break;
                }
                return newVal
            }
            var filters = currentConfig.detector_filters
            Object.keys(filters).forEach(function(key){
                var conditionChain = {}
                var dFilter = filters[key]
                dFilter.where.forEach(function(condition,place){
                    conditionChain[place] = {ok:false,next:condition.p4,matrixCount:0}
                    if(d.details.matrices)conditionChain[place].matrixCount = d.details.matrices.length
                    var modifyFilters = function(toCheck,matrixPosition){
                        var param = toCheck[condition.p1]
                        var pass = function(){
                            if(matrixPosition && dFilter.actions.halt === '1'){
                                delete(d.details.matrices[matrixPosition])
                            }else{
                                conditionChain[place].ok = true
                            }
                        }
                        switch(condition.p2){
                            case'indexOf':
                                if(param.indexOf(condition.p3) > -1){
                                    pass()
                                }
                            break;
                            case'!indexOf':
                                if(param.indexOf(condition.p3) === -1){
                                    pass()
                                }
                            break;
                            default:
                                if(eval('param '+condition.p2+' "'+condition.p3.replace(/"/g,'\\"')+'"')){
                                    pass()
                                }
                            break;
                        }
                    }
                    switch(condition.p1){
                        case'tag':
                        case'x':
                        case'y':
                        case'height':
                        case'width':
                            if(d.details.matrices){
                                d.details.matrices.forEach(function(matrix,position){
                                    modifyFilters(matrix,position)
                                })
                            }
                        break;
                        case'time':
                            var timeNow = new Date()
                            var timeCondition = new Date()
                            var doAtTime = condition.p3.split(':')
                            var atHour = parseInt(doAtTime[0]) - 1
                            var atHourNow = timeNow.getHours()
                            var atMinuteNow = timeNow.getMinutes()
                            var atSecondNow = timeNow.getSeconds()
                            if(atHour){
                                var atMinute = parseInt(doAtTime[1]) - 1 || timeNow.getMinutes()
                                var atSecond = parseInt(doAtTime[2]) - 1 || timeNow.getSeconds()
                                var nowAddedInSeconds = atHourNow * 60 * 60 + atMinuteNow * 60 + atSecondNow
                                var conditionAddedInSeconds = atHour * 60 * 60 + atMinute * 60 + atSecond
                                if(eval('nowAddedInSeconds '+condition.p2+' conditionAddedInSeconds')){
                                    conditionChain[place].ok = true
                                }
                            }
                        break;
                        default:
                            modifyFilters(d.details)
                        break;
                    }
                })
                var conditionArray = Object.values(conditionChain)
                var validationString = ''
                conditionArray.forEach(function(condition,number){
                    validationString += condition.ok+' '
                    if(conditionArray.length-1 !== number){
                        validationString += condition.next+' '
                    }
                })
                if(eval(validationString)){
                    if(dFilter.actions.halt !== '1'){
                        delete(dFilter.actions.halt)
                        Object.keys(dFilter.actions).forEach(function(key){
                            var value = dFilter.actions[key]
                            filter[key] = parseValue(key,value)
                        })
                    }else{
                        filter.halt = true
                    }
                }
            })
            if(d.details.matrices && d.details.matrices.length === 0 || filter.halt === true){
                return
            }else if(hasMatrices){
                var reviewedMatrix = []
                d.details.matrices.forEach(function(matrix){
                    if(matrix)reviewedMatrix.push(matrix)
                })
                d.details.matrices = reviewedMatrix
            }
        }
        var eventTime = new Date()
        //motion counter
        if(filter.addToMotionCounter && filter.record){
            if(!s.group[d.ke].activeMonitors[d.id].detector_motion_count){
                s.group[d.ke].activeMonitors[d.id].detector_motion_count=0
            }
            s.group[d.ke].activeMonitors[d.id].detector_motion_count+=1
        }
        if(filter.useLock){
            if(s.group[d.ke].activeMonitors[d.id].motion_lock){
                return
            }
            var detector_lock_timeout
            if(!currentConfig.detector_lock_timeout||currentConfig.detector_lock_timeout===''){
                detector_lock_timeout = 2000
            }
            detector_lock_timeout = parseFloat(currentConfig.detector_lock_timeout);
            if(!s.group[d.ke].activeMonitors[d.id].detector_lock_timeout){
                s.group[d.ke].activeMonitors[d.id].detector_lock_timeout=setTimeout(function(){
                    clearTimeout(s.group[d.ke].activeMonitors[d.id].detector_lock_timeout)
                    delete(s.group[d.ke].activeMonitors[d.id].detector_lock_timeout)
                },detector_lock_timeout)
            }else{
                return
            }
        }
        // check if object should be in region
        if(hasMatrices && currentConfig.detector_obj_region === '1'){
            var regions = s.group[d.ke].activeMonitors[d.id].parsedObjects.cords
            var isMatrixInRegions = s.isAtleastOneMatrixInRegion(regions,d.details.matrices)
            if(isMatrixInRegions){
                s.debugLog('Matrix in region!')
            }else{
                return
            }
        }
        // check modified indifference
        if(filter.indifference !== false && d.details.confidence < parseFloat(filter.indifference)){
            // fails indifference check for modified indifference
            return
        }
        //
        if(d.doObjectDetection === true){
            s.ocvTx({
                f : 'frame',
                mon : s.group[d.ke].rawMonitorConfigurations[d.id].details,
                ke : d.ke,
                id : d.id,
                time : s.formattedTime(),
                frame : s.group[d.ke].activeMonitors[d.id].lastJpegDetectorFrame
            })
        }else{
            if(currentConfig.detector_multi_trigger === '1'){
                s.getCamerasForMultiTrigger(d.mon).forEach(function(monitor){
                    if(monitor.mid !== d.id){
                        s.triggerEvent({
                            id: monitor.mid,
                            ke: monitor.ke,
                            details: {
                                confidence: 100,
                                name: "multiTrigger",
                                plug: d.details.plug,
                                reason: d.details.reason
                            }
                        })
                    }
                })
            }
            //save this detection result in SQL, only coords. not image.
            if(forceSave || (filter.save && currentConfig.detector_save === '1')){
                s.sqlQuery('INSERT INTO Events (ke,mid,details,time) VALUES (?,?,?,?)',[d.ke,d.id,detailString,eventTime])
            }
            if(currentConfig.detector_notrigger === '1'){
                var detector_notrigger_timeout
                if(!currentConfig.detector_notrigger_timeout||currentConfig.detector_notrigger_timeout === ''){
                    detector_notrigger_timeout = 10
                }
                detector_notrigger_timeout = parseFloat(currentConfig.detector_notrigger_timeout)*1000*60;
                s.group[d.ke].activeMonitors[d.id].detector_notrigger_timeout = detector_notrigger_timeout;
                clearInterval(s.group[d.ke].activeMonitors[d.id].detector_notrigger_timeout)
                s.group[d.ke].activeMonitors[d.id].detector_notrigger_timeout = setInterval(s.group[d.ke].activeMonitors[d.id].detector_notrigger_timeout_function,detector_notrigger_timeout)
            }
            var detector_timeout
            if(!currentConfig.detector_timeout||currentConfig.detector_timeout===''){
                detector_timeout = 10
            }else{
                detector_timeout = parseFloat(currentConfig.detector_timeout)
            }
            if(filter.record && d.mon.mode=='start'&&currentConfig.detector_trigger==='1'&&currentConfig.detector_record_method==='sip'){
                s.createEventBasedRecording(d,moment(eventTime).subtract(5,'seconds').format('YYYY-MM-DDTHH-mm-ss'))
            }else if(filter.record && d.mon.mode!=='stop'&&currentConfig.detector_trigger=='1'&&currentConfig.detector_record_method==='hot'){
                if(!d.auth){
                    d.auth=s.gid();
                }
                if(!s.group[d.ke].users[d.auth]){
                    s.group[d.ke].users[d.auth]={system:1,details:{},lang:lang}
                }
                d.urlQuery = []
                d.url = 'http://'+config.ip+':'+config.port+'/'+d.auth+'/monitor/'+d.ke+'/'+d.id+'/record/'+detector_timeout+'/min';
                if(currentConfig.watchdog_reset!=='0'){
                    d.urlQuery.push('reset=1')
                }
                if(currentConfig.detector_trigger_record_fps&&currentConfig.detector_trigger_record_fps!==''&&currentConfig.detector_trigger_record_fps!=='0'){
                    d.urlQuery.push('fps='+currentConfig.detector_trigger_record_fps)
                }
                if(d.urlQuery.length>0){
                    d.url+='?'+d.urlQuery.join('&')
                }
                request({url:d.url,method:'GET'},function(err,data){
                    if(err){
                        //could not start hotswap
                    }else{
                        delete(s.group[d.ke].users[d.auth])
                        d.cx.f='detector_record_engaged';
                        d.cx.msg = JSON.parse(data.body)
                        s.tx(d.cx,'GRP_'+d.ke);
                    }
                })
            }
            d.currentTime = new Date()
            d.currentTimestamp = s.timeObject(d.currentTime).format()
            d.screenshotName = 'Motion_'+(d.mon.name.replace(/[^\w\s]/gi,''))+'_'+d.id+'_'+d.ke+'_'+s.formattedTime()
            d.screenshotBuffer = null

            s.onEventTriggerExtensions.forEach(function(extender){
                extender(d,filter)
            })

            if(filter.webhook && currentConfig.detector_webhook === '1'){
                var detector_webhook_url = currentConfig.detector_webhook_url
                var detector_webhook_type = currentConfig.detector_webhook_type
                //add query string parameters to the url
                if(detector_webhook_type === 'query'){
                    detector_webhook_url = addEventDetailsToString(d,detector_webhook_url)
                }

                var options = {encoding:null};
                options.method = currentConfig.detector_webhook_method
                if(!options.method || options.method === '') options.method = 'GET'

                if(detector_webhook_type === 'body')
                {
                    options.json = true
                    options.body = {time:d.currentTime,region:d.details.name,snapshot:s.dir.streams+'/'+d.ke+'/'+d.id+'/s.jpg',monitorId:d.id,groupKey:d.ke,details:d.details};
                }

                console.log(JSON.stringify(options.body));

                request(detector_webhook_url,options,function(err,data){
                    if(err){
                        s.userLog(d,{type:lang["Event Webhook Error"],msg:{error:err,data:data}})
                    }
                })
            }

            if(filter.command && currentConfig.detector_command_enable === '1' && !s.group[d.ke].activeMonitors[d.id].detector_command){
                s.group[d.ke].activeMonitors[d.id].detector_command = s.createTimeout('detector_command',s.group[d.ke].activeMonitors[d.id],currentConfig.detector_command_timeout,10)
                var detector_command = addEventDetailsToString(d,currentConfig.detector_command)
                if(detector_command === '')return
                exec(detector_command,{detached: true},function(err){
                    if(err)s.debugLog(err)
                })
            }
        }
        //show client machines the event
        d.cx={f:'detector_trigger',id:d.id,ke:d.ke,details:d.details,doObjectDetection:d.doObjectDetection};
        s.tx(d.cx,'DETECTOR_'+d.ke+d.id);
    }
    s.createEventBasedRecording = function(d,fileTime){
        if(!fileTime)fileTime = s.formattedTime()
        d.mon = s.group[d.ke].rawMonitorConfigurations[d.id]
        var currentConfig = s.group[d.ke].activeMonitors[d.id].details
        if(currentConfig.detector !== '1'){
            return
        }
        var detector_timeout
        if(!currentConfig.detector_timeout||currentConfig.detector_timeout===''){
            detector_timeout = 10
        }else{
            detector_timeout = parseFloat(currentConfig.detector_timeout)
        }
        if(currentConfig.watchdog_reset === '1' || !s.group[d.ke].activeMonitors[d.id].eventBasedRecording.timeout){
            clearTimeout(s.group[d.ke].activeMonitors[d.id].eventBasedRecording.timeout)
            s.group[d.ke].activeMonitors[d.id].eventBasedRecording.timeout = setTimeout(function(){
                s.group[d.ke].activeMonitors[d.id].eventBasedRecording.allowEnd = true
                s.group[d.ke].activeMonitors[d.id].eventBasedRecording.process.stdin.setEncoding('utf8')
                s.group[d.ke].activeMonitors[d.id].eventBasedRecording.process.stdin.write('q')
                delete(s.group[d.ke].activeMonitors[d.id].eventBasedRecording.timeout)
            },detector_timeout * 1000 * 60)
        }
        if(!s.group[d.ke].activeMonitors[d.id].eventBasedRecording.process){
            s.group[d.ke].activeMonitors[d.id].eventBasedRecording.allowEnd = false;
            var runRecord = function(){
                var filename = fileTime+'.mp4'
                s.userLog(d,{type:lang["Traditional Recording"],msg:lang["Started"]})
                //-t 00:'+s.timeObject(new Date(detector_timeout * 1000 * 60)).format('mm:ss')+'
                s.group[d.ke].activeMonitors[d.id].eventBasedRecording.process = spawn(config.ffmpegDir,s.splitForFFPMEG(('-loglevel warning -analyzeduration 1000000 -probesize 1000000 -re -i "'+s.dir.streams+'/'+d.ke+'/'+d.id+'/detectorStream.m3u8" -c:v copy -strftime 1 "'+s.getVideoDirectory(d.mon) + filename + '"')))
                var ffmpegError='';
                var error
                s.group[d.ke].activeMonitors[d.id].eventBasedRecording.process.stderr.on('data',function(data){
                    s.userLog(d,{type:lang["Traditional Recording"],msg:data.toString()})
                })
                s.group[d.ke].activeMonitors[d.id].eventBasedRecording.process.on('close',function(){
                    if(!s.group[d.ke].activeMonitors[d.id].eventBasedRecording.allowEnd){
                        s.userLog(d,{type:lang["Traditional Recording"],msg:lang["Detector Recording Process Exited Prematurely. Restarting."]})
                        runRecord()
                        return
                    }
                    s.insertCompletedVideo(d.mon,{
                        file : filename
                    })
                    s.userLog(d,{type:lang["Traditional Recording"],msg:lang["Detector Recording Complete"]})
                    s.userLog(d,{type:lang["Traditional Recording"],msg:lang["Clear Recorder Process"]})
                    delete(s.group[d.ke].activeMonitors[d.id].eventBasedRecording.process)
                    clearTimeout(s.group[d.ke].activeMonitors[d.id].eventBasedRecording.timeout)
                    delete(s.group[d.ke].activeMonitors[d.id].eventBasedRecording.timeout)
                    clearTimeout(s.group[d.ke].activeMonitors[d.id].recordingChecker)
                })
            }
            runRecord()
        }
    }
    s.closeEventBasedRecording = function(e){
        if(s.group[e.ke].activeMonitors[e.id].eventBasedRecording.process){
            clearTimeout(s.group[e.ke].activeMonitors[e.id].eventBasedRecording.timeout)
            s.group[e.ke].activeMonitors[e.id].eventBasedRecording.allowEnd = true;
            s.group[e.ke].activeMonitors[e.id].eventBasedRecording.process.kill('SIGTERM');
        }
        // var stackedProcesses = s.group[e.ke].activeMonitors[e.id].eventBasedRecording.stackable
        // Object.keys(stackedProcesses).forEach(function(key){
        //     var item = stackedProcesses[key]
        //     clearTimeout(item.timeout)
        //     item.allowEnd = true;
        //     item.process.kill('SIGTERM');
        // })
    }
}
