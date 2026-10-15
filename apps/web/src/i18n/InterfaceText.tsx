import {useCallback} from 'react';
import {useInterfaceLocale} from './I18nProvider';
import {translateInterfaceText} from './interfaceMessages';

/** Presentation-only bridge for reference screens; shares the app locale. */
export function useInterfaceText(){
  const locale=useInterfaceLocale();
  return useCallback((text:string)=>translateInterfaceText(text,locale),[locale]);
}
export function InterfaceText({text}:{text:string}){
  const ui=useInterfaceText();
  return <>{ui(text)}</>;
}
