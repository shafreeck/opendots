import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { fetch as expoFetch } from 'expo/fetch';
import { isRunningInExpoGo } from 'expo';
import { WebView } from 'react-native-webview';
import { ConnectionController, type ConnectionError, type ConnectionState } from './src/connection.ts';
import { isProductDocument, WEBVIEW_CALLBACK_WHITELIST } from './src/policy.ts';
import { MOBILE_CAPABILITY_SCRIPT } from './src/capabilities.ts';

const copy: Record<ConnectionError,string> = {
  invalid_endpoint:'请输入完整、规范的 HTTPS 服务地址，不含路径、账号或参数。',
  phone_loopback:'localhost 和 127.0.0.1 指向这部手机。请填写已配置的 OpenDots HTTPS 服务地址。',
  unreachable:'暂时无法连接。请检查网络和服务地址；证书错误不会被忽略。',
  authentication_required:'此服务未启用登录保护，手机端不会连接。',
  invalid_server:'服务响应不符合 OpenDots 登录接口，或发生了重定向。',
  navigation_blocked:'页面离开了已确认的服务地址，连接已关闭。',
  webview_failed:'页面连接中断。重新检查连接后可再次登录；未确认操作请在记录中核查。',
};
const initial:ConnectionState={phase:'disconnected',epoch:0,origin:null,source:null,error:null};
function Client(){
  const [state,setState]=useState(initial),[endpoint,setEndpoint]=useState(''),[notice,setNotice]=useState('');
  const web=useRef<WebView>(null),back=useRef(false),controller=useRef<ConnectionController|null>(null);
  if(!controller.current)controller.current=new ConnectionController((url,init)=>expoFetch(url,init),setState);
  const connection=controller.current;
  useEffect(()=>{const subscription=AppState.addEventListener('change',next=>{if(next!=='active'){web.current?.stopLoading();back.current=false;connection.suspend();}});return()=>{subscription.remove();connection.dispose();};},[connection]);
  const disconnect=(expectedEpoch?:number)=>{if(expectedEpoch!==undefined&&expectedEpoch!==connection.snapshot().epoch)return;web.current?.stopLoading();back.current=false;setNotice('');connection.disconnect();};
  const askDisconnect=()=>{const openedEpoch=connection.snapshot().epoch;Alert.alert('断开这部手机？','本机页面将关闭，尚未发送的文字可能丢失。后台任务不会取消；这不是服务器退出登录。',[{text:'继续使用',style:'cancel'},{text:'断开',style:'destructive',onPress:()=>disconnect(openedEpoch)}]);};
  useEffect(()=>{const subscription=BackHandler.addEventListener('hardwareBackPress',()=>{if(!connection.snapshot().source)return false;if(back.current)web.current?.goBack();else askDisconnect();return true;});return()=>subscription.remove();},[connection]);
  const connect=()=>{setNotice('');back.current=false;void connection.connect(endpoint.trim());};
  const epoch=state.epoch;
  const valid=(url:string)=>Boolean(state.origin&&isProductDocument(state.origin,url));
  const blocked=()=>{if(connection.snapshot().epoch===epoch)setNotice('已阻止外部链接、弹窗或文件打开。请在电脑端处理。');};
  const containment=(url:string)=>{if(!valid(url)){web.current?.stopLoading();connection.failed(epoch,'navigation_blocked');return false;}return true;};
  const mounted=Boolean(state.source);
  return <SafeAreaView style={styles.safe} edges={['top','bottom']}><StatusBar barStyle="dark-content" backgroundColor="#f6f7f4"/>
    <View style={styles.bar}><View style={styles.brand}><View style={styles.dot}/><Text style={styles.brandText}>OpenDots</Text></View>{mounted&&<Pressable accessibilityRole="button" onPress={askDisconnect} style={styles.quiet}><Text style={styles.quietText}>断开</Text></Pressable>}</View>
    {mounted?<View style={styles.browser}>
      <View style={styles.connection}><View style={styles.smallDot}/><Text numberOfLines={1} style={styles.origin}>{state.origin}</Text>{state.phase==='loading'&&<ActivityIndicator size="small" color="#244c40"/>}</View>
      <Text style={styles.limit}>麦克风与文件传输暂不可用 · 其余操作使用真实服务</Text>
      {notice!==''&&<Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
      <WebView key={epoch} ref={web} source={{uri:state.source!}} style={styles.web}
        originWhitelist={WEBVIEW_CALLBACK_WHITELIST}
        onShouldStartLoadWithRequest={request=>{if(connection.snapshot().epoch!==epoch)return false;const allowed=valid(request.url);if(!allowed)blocked();return allowed;}}
        onLoadStart={event=>{if(connection.snapshot().epoch===epoch)containment(event.nativeEvent.url);}}
        onNavigationStateChange={event=>{if(connection.snapshot().epoch!==epoch)return;if(containment(event.url))back.current=event.canGoBack;}}
        onLoad={event=>connection.loaded(epoch,event.nativeEvent.url)}
        onError={()=>connection.failed(epoch)}
        onHttpError={event=>{if(valid(event.nativeEvent.url))connection.failed(epoch);}}
        onRenderProcessGone={()=>connection.failed(epoch)} onContentProcessDidTerminate={()=>connection.failed(epoch)}
        onOpenWindow={blocked} onFileDownload={blocked}
        injectedJavaScriptBeforeContentLoaded={MOBILE_CAPABILITY_SCRIPT} injectedJavaScript={MOBILE_CAPABILITY_SCRIPT}
        injectedJavaScriptForMainFrameOnly injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        javaScriptEnabled domStorageEnabled incognito cacheEnabled={false} cacheMode="LOAD_NO_CACHE" saveFormDataDisabled
        sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} mixedContentMode="never"
        allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows
        mediaCapturePermissionGrantType="deny" geolocationEnabled={false} allowsProtectedMedia={false}
        mediaPlaybackRequiresUserAction allowsInlineMediaPlayback={false} allowsFullscreenVideo={false}
        allowsLinkPreview={false} dataDetectorTypes="none" webviewDebuggingEnabled={false}
        applicationNameForUserAgent="OpenDotsMobile/0.1" textInteractionEnabled
        renderError={()=> <View style={styles.errorPage}><Text style={styles.errorText}>页面暂不可用，请重新连接。</Text></View>}
      />
    </View>:<KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':undefined} style={styles.keyboard}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.setup}>
      <View style={styles.card}><Text style={styles.eyebrow}>你的私人助手，随身同行</Text><Text style={styles.title}>{state.phase==='suspended'?'回来后，重新连接':'连接你的 OpenDots'}</Text>
        <Text style={styles.description}>{state.phase==='suspended'?'离开应用时，本机页面已关闭。重新检查服务后再继续，尚未确认的操作不会自动重发。':'填写你已配置的 HTTPS 服务地址，然后在真实服务页面登录。聊天、任务和提醒会与你的服务保持一致。'}</Text>
        <Text style={styles.label}>HTTPS 服务地址</Text><TextInput testID="endpoint" accessibilityLabel="HTTPS 服务地址" value={endpoint} onChangeText={setEndpoint} editable={state.phase!=='checking'} placeholder="https://你的服务域名" placeholderTextColor="#819089" autoCapitalize="none" autoCorrect={false} autoComplete="off" keyboardType="url" textContentType="URL" maxLength={2048} onSubmitEditing={connect} style={styles.input}/>
        {state.error&&<Text testID="connection-error" accessibilityLiveRegion="polite" style={styles.errorText}>{copy[state.error]}</Text>}
        <Pressable testID="connect" accessibilityRole="button" disabled={state.phase==='checking'} onPress={connect} style={[styles.primary,state.phase==='checking'&&styles.disabled]}>{state.phase==='checking'?<ActivityIndicator color="#fff"/>:<Text style={styles.primaryText}>{state.phase==='offline'?'重新检查连接':'连接服务'}</Text>}</Pressable>
        {state.phase==='checking'&&<Pressable accessibilityRole="button" onPress={()=>disconnect()} style={styles.cancel}><Text style={styles.quietText}>取消</Text></Pressable>}
        <Text style={styles.help}>手机的 localhost 不是你的服务器。服务需要有效 HTTPS 证书与登录保护；本应用不代建服务器。</Text>
      </View><Text style={styles.foot}>服务地址仅保留在当前应用内存中。断开不会取消后台任务，也不代表服务器会话已撤销。退出登录请使用服务内的账户设置。</Text></ScrollView>
    </KeyboardAvoidingView>}
  </SafeAreaView>;
}
export default function App(){const unsupported=isRunningInExpoGo()||!['ios','android'].includes(Platform.OS);return <SafeAreaProvider>{unsupported?<SafeAreaView style={styles.setup}><Text style={styles.title}>需要 OpenDots 独立客户端</Text><Text style={styles.description}>Expo Go 与浏览器不使用此应用的原生权限配置，因此不会加载服务页面。请使用经过验证的 Android 或 iOS 构建。</Text></SafeAreaView>:<Client/>}</SafeAreaProvider>;}
const styles=StyleSheet.create({safe:{flex:1,backgroundColor:'#f6f7f4'},bar:{height:58,paddingHorizontal:22,flexDirection:'row',alignItems:'center',justifyContent:'space-between',borderBottomWidth:1,borderBottomColor:'#dde4de'},brand:{flexDirection:'row',alignItems:'center',gap:10},dot:{width:21,height:21,borderRadius:11,backgroundColor:'#244c40',borderWidth:5,borderColor:'#d5f67b'},brandText:{fontSize:18,fontWeight:'600',color:'#182b28'},quiet:{padding:10},quietText:{color:'#244c40',fontSize:14},browser:{flex:1},web:{flex:1,backgroundColor:'#f6f7f4'},connection:{paddingHorizontal:18,paddingTop:12,flexDirection:'row',alignItems:'center',gap:8},smallDot:{width:6,height:6,borderRadius:3,backgroundColor:'#527d5d'},origin:{flex:1,color:'#244c40',fontSize:12},limit:{fontSize:11,color:'#62716c',paddingHorizontal:18,paddingTop:6,paddingBottom:10},notice:{padding:12,fontSize:12,color:'#695a31',backgroundColor:'#fff1cf'},keyboard:{flex:1},setup:{flexGrow:1,justifyContent:'center',padding:22},card:{padding:24,borderRadius:23,backgroundColor:'#fff',borderWidth:1,borderColor:'#dde4de'},eyebrow:{fontSize:12,color:'#62716c',marginBottom:14},title:{fontSize:27,fontWeight:'600',color:'#182b28',lineHeight:36},description:{fontSize:14,color:'#62716c',lineHeight:23,marginTop:16,marginBottom:28},label:{fontSize:13,color:'#244c40',marginBottom:10},input:{borderWidth:1,borderColor:'#cdd8c6',borderRadius:12,padding:14,fontSize:15,color:'#182b28',backgroundColor:'#fbfcf9'},primary:{marginTop:18,padding:15,borderRadius:12,backgroundColor:'#244c40',alignItems:'center',minHeight:50},primaryText:{fontSize:15,color:'#fff',fontWeight:'600'},disabled:{opacity:.65},help:{fontSize:12,color:'#62716c',lineHeight:20,marginTop:20},foot:{fontSize:11,color:'#62716c',lineHeight:19,paddingHorizontal:12,marginTop:24,textAlign:'center'},errorText:{fontSize:13,color:'#8a4935',lineHeight:21,marginTop:12},cancel:{padding:12,alignItems:'center'},errorPage:{padding:24}});
